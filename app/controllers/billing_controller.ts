import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { TwelveAiError, isTwelveAiConfigured, twelveAiMode, listBanks, resolveAccount, verifyTwelveAiSignature } from '#services/twelveai'
import { billingState, catalogue, studentCount, subscribe, syncSubscription, cancelAtPeriodEnd, serializeSub, syncByGatewayId, forgetStatus } from '#services/billing'
import { balanceKobo, startTopup, confirmTopup, prices, WELCOME_KOBO, MIN_BALANCE_KOBO, TOPUP_MIN_KOBO, TOPUP_MAX_KOBO } from '#services/ai_credits'

function fail(ctx: HttpContext, e: unknown) {
  if (e instanceof TwelveAiError) return ctx.response.status(e.status).send({ message: e.message })
  logger.error({ err: e }, 'billing request failed')
  return ctx.response.internalServerError({ message: 'Something went wrong. Please try again.' })
}

function payerEmail(user: { id: number; email: string }) {
  return user.email.endsWith('.local') || user.email.endsWith('.test') ? `billing+${user.id}@schoolify.twelveai.app` : user.email
}

function frontend() {
  return (env.get('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')
}

/** Simple per-user limit for account lookups (TwelveAI allows 30 a minute in total). */
const lookups = new Map<number, number[]>()
function allowLookup(userId: number) {
  const now = Date.now()
  const recent = (lookups.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= 10) return false
  recent.push(now)
  lookups.set(userId, recent)
  return true
}

export default class BillingController {
  /** GET billing - plan, trial, AI credit and recent activity. */
  async overview(ctx: HttpContext) {
    const school = ctx.school
    try {
      // Bring open checkouts up to date so the page is right after a return.
      const open = await db
        .from('school_subscriptions')
        .where('school_id', school.id)
        .whereNotNull('gateway_id')
        .whereIn('status', ['incomplete', 'active', 'trialing', 'past_due'])
        .where((q) => q.whereNull('last_synced_at').orWhere('last_synced_at', '<', new Date(Date.now() - 60_000)))
        .limit(3)
      for (const r of open) await syncSubscription(r).catch(() => null)
      forgetStatus(school.id)
    } catch {
      // The page still renders from what we have.
    }
    // First, so the welcome grant exists before the ledger is read.
    const balance = await balanceKobo(school.id)
    const [state, students, history, txns, usage, topups] = await Promise.all([
      billingState(school),
      studentCount(school.id),
      db.from('school_subscriptions').where('school_id', school.id).whereNot('status', 'abandoned').orderBy('id', 'desc').limit(10),
      db.from('ai_credit_transactions').where('school_id', school.id).whereNot('kind', 'usage').orderBy('id', 'desc').limit(20),
      db
        .from('ai_credit_transactions')
        .where('school_id', school.id)
        .where('kind', 'usage')
        .where('created_at', '>', new Date(Date.now() - 30 * 86_400_000))
        .groupBy('feature')
        .select('feature')
        .count('* as calls')
        .sum('amount_kobo as total'),
      db.from('billing_payments').where('school_id', school.id).orderBy('id', 'desc').limit(10),
    ])
    const pending = history.find((r: any) => r.status === 'incomplete')
    return ctx.serialize({
      configured: isTwelveAiConfigured(),
      mode: isTwelveAiConfigured() ? twelveAiMode() : null,
      enforced: !!env.get('BILLING_ENFORCE'),
      students,
      ...state,
      pendingCheckout: pending ? serializeSub(pending) : null,
      history: history.map(serializeSub),
      catalogue: catalogue(students),
      credits: {
        balanceKobo: balance,
        welcomeKobo: WELCOME_KOBO,
        minBalanceKobo: MIN_BALANCE_KOBO,
        topupMinKobo: TOPUP_MIN_KOBO,
        topupMaxKobo: TOPUP_MAX_KOBO,
        prices: prices(),
        usage30d: (usage as any[])
          .map((u) => ({ feature: u.feature, calls: Number(u.calls), costKobo: -Number(u.total) }))
          .sort((a, b) => b.costKobo - a.costKobo),
        transactions: txns.map((t: any) => ({
          id: Number(t.id),
          kind: t.kind,
          amountKobo: Number(t.amount_kobo),
          balanceAfterKobo: Number(t.balance_after_kobo),
          note: t.note,
          createdAt: t.created_at,
        })),
        topups: topups.map((t: any) => ({
          reference: t.reference,
          amountKobo: Number(t.amount_kobo),
          status: t.status,
          mode: t.mode,
          paidAt: t.paid_at,
          createdAt: t.created_at,
        })),
      },
    })
  }

  /** POST billing/subscribe { planKey, intervalKey } -> { checkoutUrl } */
  async subscribe(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    try {
      const res = await subscribe({
        school: ctx.school,
        userId: user.id,
        email: payerEmail(user),
        planKey: String(ctx.request.input('planKey') ?? ''),
        intervalKey: String(ctx.request.input('intervalKey') ?? ''),
      })
      return ctx.serialize(res)
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** POST billing/subscriptions/:id/refresh - after the payer returns. */
  async refresh(ctx: HttpContext) {
    const row = await db.from('school_subscriptions').where('id', Number(ctx.params.id)).where('school_id', ctx.school.id).first()
    if (!row) return ctx.response.notFound({ message: 'Subscription not found.' })
    try {
      const fresh = await syncSubscription(row)
      forgetStatus(ctx.school.id)
      return ctx.serialize(serializeSub(fresh))
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** POST billing/subscriptions/:id/cancel - stops renewal at period end. */
  async cancel(ctx: HttpContext) {
    try {
      const row = await cancelAtPeriodEnd(ctx.school.id, Number(ctx.params.id))
      forgetStatus(ctx.school.id)
      return ctx.serialize(serializeSub(row))
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** POST billing/ai-credits/topup { amountKobo } -> { checkoutUrl } */
  async topup(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    try {
      const res = await startTopup({
        schoolId: ctx.school.id,
        schoolName: ctx.school.name,
        userId: user.id,
        email: payerEmail(user),
        amountKobo: Math.round(Number(ctx.request.input('amountKobo'))),
        callbackBase: frontend(),
      })
      return ctx.serialize(res)
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** POST billing/ai-credits/topups/:reference/confirm */
  async confirmTopup(ctx: HttpContext) {
    try {
      const status = await confirmTopup(String(ctx.params.reference), ctx.school.id)
      if (status === 'unknown') return ctx.response.notFound({ message: 'Top-up not found.' })
      return ctx.serialize({ status, balanceKobo: await balanceKobo(ctx.school.id) })
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** GET banks - Nigerian banks for account lookups. */
  async banks(ctx: HttpContext) {
    try {
      return ctx.serialize(await listBanks())
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /** GET banks/resolve?accountNumber=&bankCode= -> { accountName } */
  async resolve(ctx: HttpContext) {
    const accountNumber = String(ctx.request.input('accountNumber') ?? '').trim()
    const bankCode = String(ctx.request.input('bankCode') ?? '').trim()
    if (!/^\d{10}$/.test(accountNumber)) return ctx.response.badRequest({ message: 'Account numbers have 10 digits.' })
    if (!/^[0-9A-Za-z]{2,12}$/.test(bankCode)) return ctx.response.badRequest({ message: 'Choose the bank.' })
    if (!allowLookup(ctx.auth.getUserOrFail().id)) {
      return ctx.response.tooManyRequests({ message: 'Too many lookups. Wait a minute and try again.' })
    }
    try {
      return ctx.serialize(await resolveAccount(accountNumber, bankCode))
    } catch (e) {
      return fail(ctx, e)
    }
  }

  /**
   * POST /api/v1/billing/webhook - TwelveAI events for Schoolify's account.
   * Signed with TWELVEAI_WEBHOOK_SECRET; every event is only a hint to
   * re-read the truth from the API, so a forged body can never add credit.
   */
  async webhook({ request, response }: HttpContext) {
    const raw = request.raw() ?? ''
    if (!verifyTwelveAiSignature(raw, request.headers(), env.get('TWELVEAI_WEBHOOK_SECRET')?.release())) {
      return response.unauthorized({ message: 'Invalid signature' })
    }
    let body: any
    try {
      body = JSON.parse(raw)
    } catch {
      return response.badRequest({ message: 'Body must be JSON' })
    }
    const event = String(body?.event ?? '')
    try {
      if (event === 'charge.success' && String(body?.data?.reference ?? '').startsWith('sfy_ai_')) {
        await confirmTopup(String(body.data.reference))
      } else if (event.startsWith('subscription.') && body?.data?.id) {
        await syncByGatewayId(String(body.data.id))
      }
      return response.ok({ received: true })
    } catch (e) {
      logger.error({ err: e, event }, 'billing webhook failed')
      return response.serviceUnavailable({ message: 'Retry later' })
    }
  }
}
