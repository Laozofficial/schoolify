import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import School from '#models/school'
import { PLANS, INTERVALS, TRIAL_DAYS, planFor, intervalFor, gatewaySpec } from '#services/billing_plans'
import {
  ensurePlan,
  createSubscription,
  getSubscription,
  cancelSubscription,
  twelveAiMode,
  TwelveAiError,
  type GatewaySubscription,
} from '#services/twelveai'

/**
 * A school's Schoolify plan. TwelveAI holds the card and charges renewals;
 * we mirror each subscription in school_subscriptions and refresh it on the
 * billing page, when the payer comes back from checkout, from webhooks
 * (when configured) and from a background sweep.
 */

export type BillingStatus = 'trial' | 'active' | 'past_due' | 'expired'

const LIVE_STATUSES = ['active', 'trialing', 'past_due']

export function studentCount(schoolId: number): Promise<number> {
  return db
    .from('students')
    .where('school_id', schoolId)
    .where('is_archived', false)
    .count('* as n')
    .first()
    .then((r: any) => Number(r?.n ?? 0))
}

/** The subscription that currently gives the school access, if any. */
async function currentSubscription(schoolId: number) {
  const now = new Date()
  return db
    .from('school_subscriptions')
    .where('school_id', schoolId)
    .where((q) =>
      q
        .whereIn('status', LIVE_STATUSES)
        // A plan cancelled at period end keeps working until then.
        .orWhere((c) => c.where('status', 'cancelled').where('current_period_end', '>', now))
    )
    .orderBy('id', 'desc')
    .first()
}

export async function billingState(school: School) {
  const sub = await currentSubscription(school.id)
  const trialEndsAt: Date | null = school.trialEndsAt?.toJSDate() ?? null
  const trialEnd = trialEndsAt ?? new Date(new Date(school.createdAt.toJSDate()).getTime() + TRIAL_DAYS * 86_400_000)
  const now = Date.now()
  let status: BillingStatus
  if (sub && sub.status === 'past_due') status = 'past_due'
  else if (sub) status = 'active'
  else if (trialEnd.getTime() > now) status = 'trial'
  else status = 'expired'
  return {
    status,
    trialEndsAt: trialEnd.toISOString(),
    trialDaysLeft: Math.max(0, Math.ceil((trialEnd.getTime() - now) / 86_400_000)),
    subscription: sub ? serializeSub(sub) : null,
  }
}

export function serializeSub(r: any) {
  const plan = planFor(r.plan_key)
  const interval = intervalFor(r.interval_key)
  return {
    id: r.id,
    planKey: r.plan_key,
    planName: plan?.name ?? r.plan_key,
    intervalKey: r.interval_key,
    intervalLabel: interval?.label ?? r.interval_key,
    amountKobo: Number(r.amount_kobo),
    mode: r.mode,
    status: r.status,
    currentPeriodEnd: r.current_period_end,
    nextChargeAt: r.next_charge_at,
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    card: r.card_last4 ? { brand: r.card_brand, last4: r.card_last4 } : null,
    lastFailureReason: r.last_failure_reason,
    checkoutUrl: r.status === 'incomplete' ? r.checkout_url : null,
    createdAt: r.created_at,
  }
}

export function catalogue(students: number) {
  return {
    trialDays: TRIAL_DAYS,
    intervals: INTERVALS.map((i) => ({ key: i.key, label: i.label, per: i.per })),
    plans: PLANS.map((p) => ({
      key: p.key,
      name: p.name,
      blurb: p.blurb,
      maxStudents: p.maxStudents,
      prices: p.prices,
      highlights: p.highlights,
      fits: p.maxStudents === null || students <= p.maxStudents,
    })),
  }
}

/* ------------------------------------------------------------------ */
/* Subscribe, sync, cancel                                              */
/* ------------------------------------------------------------------ */

export async function subscribe(p: { school: School; userId: number; email: string; planKey: string; intervalKey: string }) {
  const plan = planFor(p.planKey)
  const interval = intervalFor(p.intervalKey)
  if (!plan || !interval) throw new TwelveAiError('Choose a plan and how often to pay.', 400)
  const students = await studentCount(p.school.id)
  if (plan.maxStudents !== null && students > plan.maxStudents) {
    throw new TwelveAiError(`${plan.name} covers up to ${plan.maxStudents} students and your school has ${students}. Choose a bigger plan.`, 400)
  }
  const current = await currentSubscription(p.school.id)
  if (current && current.plan_key === plan.key && current.interval_key === interval.key && current.status !== 'cancelled') {
    throw new TwelveAiError('Your school is already on this plan.', 409)
  }

  const spec = gatewaySpec(plan, interval)
  const planCode = await ensurePlan(spec)
  const [{ id }] = await db
    .table('school_subscriptions')
    .insert({
      school_id: p.school.id,
      plan_key: plan.key,
      interval_key: interval.key,
      amount_kobo: spec.amountKobo,
      mode: twelveAiMode(),
      status: 'incomplete',
      created_by_user_id: p.userId,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('id')

  const frontend = (env.get('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')
  try {
    const res = await createSubscription({
      planCode,
      email: p.email,
      name: p.school.name,
      callbackUrl: `${frontend}/settings/billing?subscription=${id}`,
      metadata: { product: 'schoolify', school_id: p.school.id, local_id: id },
    })
    await db.from('school_subscriptions').where('id', id).update({
      gateway_id: res.subscription.id || null,
      gateway_reference: res.reference,
      checkout_url: res.checkoutUrl,
      status: res.subscription.status || 'incomplete',
      updated_at: new Date(),
    })
    return { id, checkoutUrl: res.checkoutUrl }
  } catch (e) {
    await db.from('school_subscriptions').where('id', id).update({ status: 'abandoned', updated_at: new Date() })
    throw e
  }
}

async function applyGateway(row: any, g: GatewaySubscription) {
  const wasLive = LIVE_STATUSES.includes(row.status)
  await db.from('school_subscriptions').where('id', row.id).update({
    status: g.status,
    amount_kobo: g.amountKobo || row.amount_kobo,
    current_period_end: g.currentPeriodEnd ? new Date(g.currentPeriodEnd) : null,
    next_charge_at: g.nextChargeAt ? new Date(g.nextChargeAt) : null,
    cancel_at_period_end: g.cancelAtPeriodEnd,
    card_brand: g.card?.brand ?? row.card_brand,
    card_last4: g.card?.last4 ?? row.card_last4,
    last_failure_reason: g.lastFailureReason?.slice(0, 300) ?? null,
    last_synced_at: new Date(),
    updated_at: new Date(),
  })
  // A new plan just started: end the one it replaces straight away.
  if (!wasLive && LIVE_STATUSES.includes(g.status)) {
    const older = await db
      .from('school_subscriptions')
      .where('school_id', row.school_id)
      .whereNot('id', row.id)
      .where((q) => q.whereIn('status', LIVE_STATUSES).orWhere((c) => c.where('status', 'cancelled').where('current_period_end', '>', new Date())))
    for (const o of older) {
      try {
        if (o.gateway_id && o.status !== 'cancelled') await cancelSubscription(o.gateway_id, false)
      } catch (e) {
        logger.warn({ err: e, id: o.id }, 'could not cancel replaced subscription')
      }
      await db.from('school_subscriptions').where('id', o.id).update({ status: 'cancelled', current_period_end: new Date(), updated_at: new Date() })
    }
    statusCache.delete(row.school_id)
  }
  if (wasLive !== LIVE_STATUSES.includes(g.status)) statusCache.delete(row.school_id)
}

/** Refresh one subscription from TwelveAI. */
export async function syncSubscription(row: any): Promise<any> {
  if (!row.gateway_id) return row
  // Checkouts nobody finished: stop treating them as open after three days.
  if (row.status === 'incomplete' && Date.now() - new Date(row.created_at).getTime() > 3 * 86_400_000) {
    const g = await getSubscription(row.gateway_id).catch(() => null)
    if (!g || g.status === 'incomplete') {
      await cancelSubscription(row.gateway_id, false).catch(() => null)
      await db.from('school_subscriptions').where('id', row.id).update({ status: 'abandoned', last_synced_at: new Date(), updated_at: new Date() })
      return db.from('school_subscriptions').where('id', row.id).first()
    }
    await applyGateway(row, g)
    return db.from('school_subscriptions').where('id', row.id).first()
  }
  const g = await getSubscription(row.gateway_id)
  await applyGateway(row, g)
  return db.from('school_subscriptions').where('id', row.id).first()
}

export async function syncByGatewayId(gatewayId: string) {
  const row = await db.from('school_subscriptions').where('gateway_id', gatewayId).first()
  if (row) await syncSubscription(row)
}

export async function cancelAtPeriodEnd(schoolId: number, id: number) {
  const row = await db.from('school_subscriptions').where('id', id).where('school_id', schoolId).first()
  if (!row || !row.gateway_id) throw new TwelveAiError('Subscription not found.', 404)
  if (!LIVE_STATUSES.includes(row.status)) throw new TwelveAiError('This plan is not active.', 400)
  const g = await cancelSubscription(row.gateway_id, true)
  await applyGateway(row, g)
  return db.from('school_subscriptions').where('id', row.id).first()
}

/** Background net for renewals, failed charges and unfinished checkouts. */
export async function sweepSubscriptions(): Promise<number> {
  const now = Date.now()
  const stale = new Date(now - 5 * 60_000)
  const rows = await db
    .from('school_subscriptions')
    .whereNotNull('gateway_id')
    .where((q) =>
      q
        .where((c) => c.where('status', 'incomplete').where('created_at', '>', new Date(now - 4 * 86_400_000)))
        .orWhere((c) => c.whereIn('status', LIVE_STATUSES).where((d) => d.where('next_charge_at', '<', new Date()).orWhere('current_period_end', '<', new Date()).orWhereNull('current_period_end')))
        .orWhere((c) => c.where('status', 'cancelled').where('current_period_end', '>', new Date()))
    )
    .where((q) => q.whereNull('last_synced_at').orWhere('last_synced_at', '<', stale))
    .orderBy('id', 'asc')
    .limit(50)
  let n = 0
  for (const r of rows) {
    try {
      await syncSubscription(r)
      n++
    } catch (e) {
      logger.warn({ err: e, id: r.id }, 'subscription sync failed')
    }
  }
  return n
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                          */
/* ------------------------------------------------------------------ */

const statusCache = new Map<number, { at: number; status: BillingStatus }>()

/** Cached for a minute; used by the access middleware on every request. */
export async function cachedStatus(schoolId: number): Promise<BillingStatus> {
  const hit = statusCache.get(schoolId)
  if (hit && Date.now() - hit.at < 60_000) return hit.status
  const school = await School.find(schoolId)
  if (!school) return 'active'
  const { status } = await billingState(school)
  statusCache.set(schoolId, { at: Date.now(), status })
  return status
}

export function forgetStatus(schoolId: number) {
  statusCache.delete(schoolId)
}
