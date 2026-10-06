import { randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { initializePayment, verifyPayment, twelveAiMode, TwelveAiError } from '#services/twelveai'

/**
 * Prepaid AI credit per school, in kobo.
 * - Every school gets a one-off NGN 5,000 welcome grant the first time its
 *   account is touched.
 * - Each AI call is charged from its token usage (input and output priced
 *   per 1,000 tokens) after it returns, so a call that started is never cut
 *   off halfway. A new call is refused once the balance is below the floor.
 * - Top-ups are paid through Schoolify's TwelveAI account and credited once,
 *   whichever of the return page or the background sweep sees them first.
 */

export const WELCOME_KOBO = 5_000 * 100
export const MIN_BALANCE_KOBO = 20 * 100
export const TOPUP_MIN_KOBO = 1_000 * 100
export const TOPUP_MAX_KOBO = 1_000_000 * 100
/** A checkout the payer has not finished reads as failed; give it time. */
const FAILURE_GRACE_MINUTES = 60

export function prices() {
  return {
    inputKoboPer1k: env.get('AI_PRICE_KOBO_PER_1K_INPUT') ?? 1200,
    outputKoboPer1k: env.get('AI_PRICE_KOBO_PER_1K_OUTPUT') ?? 7200,
  }
}

export function costKobo(promptTokens: number, completionTokens: number): number {
  const p = prices()
  return Math.ceil((promptTokens * p.inputKoboPer1k) / 1000 + (completionTokens * p.outputKoboPer1k) / 1000)
}

function isUniqueViolation(e: unknown) {
  return (e as any)?.code === '23505'
}

/**
 * Add credit once per reference. Returns false when that reference was
 * already applied (so retries, double clicks and the sweep are all safe).
 */
async function grant(p: { schoolId: number; kind: 'welcome' | 'topup' | 'adjust'; amountKobo: number; reference: string; userId?: number | null; note?: string }): Promise<boolean> {
  try {
    return await db.transaction(async (trx) => {
      await trx.rawQuery(
        'INSERT INTO ai_credit_accounts (school_id, balance_kobo, created_at, updated_at) VALUES (?, 0, NOW(), NOW()) ON CONFLICT (school_id) DO NOTHING',
        [p.schoolId]
      )
      const seen = await trx.from('ai_credit_transactions').where('reference', p.reference).first()
      if (seen) return false
      const res = await trx.rawQuery(
        'UPDATE ai_credit_accounts SET balance_kobo = balance_kobo + ?, updated_at = NOW() WHERE school_id = ? RETURNING balance_kobo',
        [p.amountKobo, p.schoolId]
      )
      await trx.table('ai_credit_transactions').insert({
        school_id: p.schoolId,
        kind: p.kind,
        amount_kobo: p.amountKobo,
        balance_after_kobo: Number(res.rows[0].balance_kobo),
        reference: p.reference,
        user_id: p.userId ?? null,
        note: p.note ?? null,
        created_at: new Date(),
      })
      return true
    })
  } catch (e) {
    if (isUniqueViolation(e)) return false
    throw e
  }
}

/** The school's balance, creating the account (with the welcome grant) on first use. */
export async function balanceKobo(schoolId: number): Promise<number> {
  const row = await db.from('ai_credit_accounts').where('school_id', schoolId).select('balance_kobo').first()
  if (row) return Number(row.balance_kobo)
  await grant({ schoolId, kind: 'welcome', amountKobo: WELCOME_KOBO, reference: `welcome:${schoolId}`, note: 'Welcome credit' })
  const fresh = await db.from('ai_credit_accounts').where('school_id', schoolId).select('balance_kobo').first()
  return Number(fresh?.balance_kobo ?? 0)
}

/** Why an AI call cannot start, or null when the school has credit. */
export async function creditsBlockMessage(schoolId: number | null): Promise<string | null> {
  if (!schoolId) return null
  const bal = await balanceKobo(schoolId)
  if (bal >= MIN_BALANCE_KOBO) return null
  return 'Your school has used up its AI credit. An admin can top up in Settings, Billing.'
}

/** Charge one finished AI call to the school. Never throws. */
export async function chargeUsage(p: {
  schoolId: number | null
  userId: number | null
  feature: string
  aiCallId: number | null
  promptTokens: number
  completionTokens: number
}): Promise<void> {
  if (!p.schoolId) return
  const cost = costKobo(p.promptTokens, p.completionTokens)
  if (cost <= 0) return
  try {
    await balanceKobo(p.schoolId)
    await db.transaction(async (trx) => {
      const res = await trx.rawQuery(
        'UPDATE ai_credit_accounts SET balance_kobo = balance_kobo - ?, updated_at = NOW() WHERE school_id = ? RETURNING balance_kobo',
        [cost, p.schoolId as number]
      )
      await trx.table('ai_credit_transactions').insert({
        school_id: p.schoolId,
        kind: 'usage',
        amount_kobo: -cost,
        balance_after_kobo: Number(res.rows[0]?.balance_kobo ?? 0),
        feature: p.feature.slice(0, 40),
        ai_call_id: p.aiCallId,
        user_id: p.userId,
        created_at: new Date(),
      })
      if (p.aiCallId) await trx.from('ai_calls').where('id', p.aiCallId).update({ cost_kobo: cost })
    })
  } catch (e) {
    logger.error({ err: e, schoolId: p.schoolId, feature: p.feature }, 'ai credit charge failed')
  }
}

/* ------------------------------------------------------------------ */
/* Top-ups                                                              */
/* ------------------------------------------------------------------ */

export async function startTopup(p: { schoolId: number; schoolName: string; userId: number; email: string; amountKobo: number; callbackBase: string }) {
  if (!Number.isInteger(p.amountKobo) || p.amountKobo < TOPUP_MIN_KOBO || p.amountKobo > TOPUP_MAX_KOBO) {
    throw new TwelveAiError('Top up between NGN 1,000 and NGN 1,000,000.', 400)
  }
  // Never starts with tw_topup_: that prefix belongs to another product on the same account.
  const reference = `sfy_ai_${p.schoolId}_${randomBytes(6).toString('hex')}`
  const init = await initializePayment({
    email: p.email,
    amountKobo: p.amountKobo,
    reference,
    callbackUrl: `${p.callbackBase}/settings/billing?topup=${encodeURIComponent(reference)}`,
    customerName: p.schoolName,
    metadata: { product: 'schoolify', kind: 'ai_credits', school_id: p.schoolId },
  })
  await db.table('billing_payments').insert({
    school_id: p.schoolId,
    kind: 'ai_credits',
    reference: init.reference,
    amount_kobo: p.amountKobo,
    mode: twelveAiMode(),
    status: 'pending',
    checkout_url: init.checkoutUrl,
    user_id: p.userId,
    created_at: new Date(),
    updated_at: new Date(),
  })
  return { reference: init.reference, checkoutUrl: init.checkoutUrl }
}

/**
 * Ask TwelveAI about a top-up and credit it if it was paid. Safe to call
 * any number of times. Returns the top-up's status afterwards.
 */
export async function confirmTopup(reference: string, schoolId?: number): Promise<'successful' | 'failed' | 'pending' | 'unknown'> {
  const q = db.from('billing_payments').where('reference', reference).where('kind', 'ai_credits')
  if (schoolId) q.where('school_id', schoolId)
  const row = await q.first()
  if (!row) return 'unknown'
  if (row.status === 'successful') {
    // Covers a crash between marking it paid and crediting it.
    await grant({ schoolId: row.school_id, kind: 'topup', amountKobo: Number(row.amount_kobo), reference: `topup:${reference}`, userId: row.user_id, note: 'Top-up' })
    return 'successful'
  }
  if (row.status === 'failed') return 'failed'

  const v = await verifyPayment(reference)
  const now = new Date()
  if (v.status === 'successful') {
    await db.from('billing_payments').where('id', row.id).update({ status: 'successful', paid_at: v.paidAt ? new Date(v.paidAt) : now, last_checked_at: now, updated_at: now })
    await grant({ schoolId: row.school_id, kind: 'topup', amountKobo: Number(row.amount_kobo), reference: `topup:${reference}`, userId: row.user_id, note: 'Top-up' })
    return 'successful'
  }
  const ageMin = (now.getTime() - new Date(row.created_at).getTime()) / 60_000
  if (v.status === 'failed' && ageMin > FAILURE_GRACE_MINUTES) {
    await db.from('billing_payments').where('id', row.id).where('status', 'pending').update({ status: 'failed', last_checked_at: now, updated_at: now })
    return 'failed'
  }
  await db.from('billing_payments').where('id', row.id).update({ last_checked_at: now })
  return 'pending'
}

/** Background net: re-check open top-ups; give up on them after a day. */
export async function sweepTopups(): Promise<number> {
  const now = Date.now()
  const rows = await db
    .from('billing_payments')
    .where('status', 'pending')
    .where('created_at', '>', new Date(now - 26 * 3600_000))
    .where((q) => q.whereNull('last_checked_at').orWhere('last_checked_at', '<', new Date(now - 2 * 60_000)))
    .orderBy('created_at', 'asc')
    .limit(50)
  let credited = 0
  for (const r of rows) {
    try {
      const s = await confirmTopup(r.reference)
      if (s === 'successful') credited++
      else if (s === 'pending' && now - new Date(r.created_at).getTime() > 24 * 3600_000) {
        await db.from('billing_payments').where('id', r.id).where('status', 'pending').update({ status: 'failed', updated_at: new Date() })
      }
    } catch (e) {
      logger.warn({ err: e, reference: r.reference }, 'top-up check failed')
    }
  }
  return credited
}
