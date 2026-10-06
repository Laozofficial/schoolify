import { createHmac, timingSafeEqual } from 'node:crypto'
import env from '#start/env'

/**
 * Schoolify's own TwelveAI Business account (the platform collecting from
 * schools: plan subscriptions, AI credit top-ups) plus bank lookups.
 *
 * This is NOT how schools collect fees from parents: that money goes to the
 * school's own Paystack, Flutterwave or TwelveAI connection
 * (integrations/extra_providers.ts), never to this account.
 *
 * API: https://api.twelveai.app/api/business/v1, Bearer tw_test_/tw_live_
 * secret key, amounts in kobo, every response { success, message?, data? }.
 */

export class TwelveAiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 20_000

function baseUrl() {
  return (env.get('TWELVEAI_BASE_URL') ?? 'https://api.twelveai.app/api/business/v1').replace(/\/$/, '')
}

function secretKey(): string | null {
  return env.get('TWELVEAI_SECRET_KEY')?.release() || null
}

export function isTwelveAiConfigured(): boolean {
  return !!secretKey()
}

/** test or live, read from the key itself. */
export function twelveAiMode(): 'test' | 'live' {
  return /^(tw|sk)_live_/.test(secretKey() ?? '') ? 'live' : 'test'
}

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<any> {
  const key = secretKey()
  if (!key) throw new TwelveAiError('Payments are not set up on this server yet.', 503)
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new TwelveAiError('Could not reach the payment service. Try again shortly.', 502)
  }
  const json = (await res.json().catch(() => null)) as any
  if (!res.ok || json?.success === false) {
    const status = res.status >= 500 || !res.status ? 502 : res.status === 401 ? 502 : res.status
    throw new TwelveAiError(String(json?.message ?? `Payment service error (${res.status})`).slice(0, 300), status)
  }
  return json?.data ?? null
}

/* ------------------------------------------------------------------ */
/* One-off payments                                                     */
/* ------------------------------------------------------------------ */

export async function initializePayment(p: {
  email: string
  amountKobo: number
  reference: string
  callbackUrl: string
  customerName?: string
  metadata?: Record<string, unknown>
}): Promise<{ reference: string; checkoutUrl: string }> {
  const data = await call('POST', '/payments/initialize', {
    email: p.email,
    amount: p.amountKobo,
    reference: p.reference,
    callback_url: p.callbackUrl,
    customer_name: p.customerName,
    metadata: p.metadata,
  })
  const checkoutUrl = data?.checkout_url ?? data?.authorization_url
  if (!checkoutUrl) throw new TwelveAiError('The payment service did not return a checkout link.', 502)
  return { reference: String(data?.reference ?? p.reference), checkoutUrl }
}

export type PaymentState = 'successful' | 'failed' | 'pending'

export async function verifyPayment(reference: string): Promise<{ status: PaymentState; amountKobo: number; paidAt: string | null }> {
  const data = await call('GET', `/payments/verify/${encodeURIComponent(reference)}`)
  const s = String(data?.status ?? '').toLowerCase()
  const status: PaymentState = s === 'successful' || s === 'success' ? 'successful' : s === 'failed' || s === 'abandoned' || s === 'reversed' ? 'failed' : 'pending'
  return { status, amountKobo: Number(data?.amount ?? 0), paidAt: data?.paid_at ?? null }
}

/* ------------------------------------------------------------------ */
/* Plans and subscriptions                                              */
/* ------------------------------------------------------------------ */

export interface GatewayPlanSpec {
  /** Our stable key, kept in the plan's metadata (e.g. "standard:termly"). */
  key: string
  name: string
  description: string
  amountKobo: number
  interval: 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  intervalCount: number
}

const planCodes = new Map<string, string>()

/**
 * Find (or create) the TwelveAI plan for one of our price points. A changed
 * price is pushed to the existing plan; a changed interval cannot be, so it
 * gets a new plan and the old one is archived.
 */
export async function ensurePlan(spec: GatewayPlanSpec): Promise<string> {
  const mode = twelveAiMode()
  const cacheKey = `${mode}:${spec.key}:${spec.amountKobo}:${spec.interval}:${spec.intervalCount}`
  const cached = planCodes.get(cacheKey)
  if (cached) return cached

  const data = await call('GET', '/plans?status=active')
  const plans: any[] = data?.plans ?? []
  const mine = plans.filter((p) => p?.metadata?.schoolify_key === spec.key)
  let match = mine.find((p) => p.interval === spec.interval && Number(p.interval_count ?? 1) === spec.intervalCount)
  for (const stale of mine.filter((p) => p !== match)) {
    await call('POST', `/plans/${encodeURIComponent(stale.id)}/archive`).catch(() => null)
  }
  if (match && Number(match.amount) !== spec.amountKobo) {
    await call('PATCH', `/plans/${encodeURIComponent(match.id)}`, { amount: spec.amountKobo, name: spec.name, description: spec.description })
  }
  if (!match) {
    match = await call('POST', '/plans', {
      name: spec.name,
      description: spec.description,
      amount: spec.amountKobo,
      interval: spec.interval,
      interval_count: spec.intervalCount,
      metadata: { schoolify_key: spec.key },
    })
    match = match?.plan ?? match
  }
  const code = String(match?.id ?? '')
  if (!code) throw new TwelveAiError('Could not set up the billing plan.', 502)
  planCodes.set(cacheKey, code)
  return code
}

export interface GatewaySubscription {
  id: string
  status: string
  amountKobo: number
  currentPeriodEnd: string | null
  nextChargeAt: string | null
  cancelAtPeriodEnd: boolean
  lastFailureReason: string | null
  card: { brand: string | null; last4: string | null } | null
  metadata: Record<string, any>
}

function toSubscription(s: any): GatewaySubscription {
  return {
    id: String(s?.id ?? ''),
    status: String(s?.status ?? 'incomplete'),
    amountKobo: Number(s?.amount ?? 0),
    currentPeriodEnd: s?.current_period_end ?? null,
    nextChargeAt: s?.next_charge_at ?? null,
    cancelAtPeriodEnd: s?.cancel_at_period_end === true,
    lastFailureReason: s?.last_failure_reason ?? null,
    card: s?.card ? { brand: s.card.brand ?? null, last4: s.card.last4 ?? null } : null,
    metadata: s?.metadata ?? {},
  }
}

export async function createSubscription(p: {
  planCode: string
  email: string
  name: string
  callbackUrl: string
  metadata: Record<string, unknown>
}): Promise<{ subscription: GatewaySubscription; checkoutUrl: string; reference: string | null }> {
  const data = await call('POST', '/subscriptions', {
    plan: p.planCode,
    email: p.email,
    name: p.name,
    callback_url: p.callbackUrl,
    metadata: p.metadata,
  })
  const checkoutUrl = data?.checkout_url ?? data?.authorization_url
  if (!checkoutUrl) throw new TwelveAiError('The payment service did not return a checkout link.', 502)
  return { subscription: toSubscription(data?.subscription), checkoutUrl, reference: data?.reference ?? null }
}

export async function getSubscription(id: string): Promise<GatewaySubscription> {
  const data = await call('GET', `/subscriptions/${encodeURIComponent(id)}`)
  return toSubscription(data?.subscription ?? data)
}

export async function cancelSubscription(id: string, atPeriodEnd: boolean): Promise<GatewaySubscription> {
  const data = await call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { at_period_end: atPeriodEnd })
  return toSubscription(data?.subscription ?? data)
}

/* ------------------------------------------------------------------ */
/* Banks                                                                */
/* ------------------------------------------------------------------ */

let bankCache: { at: number; banks: { code: string; name: string }[] } | null = null
const resolveCache = new Map<string, { at: number; name: string; bankName: string }>()
const DAY = 24 * 60 * 60 * 1000

/** Nigerian banks with the codes account lookups use. Cached for a day. */
export async function listBanks(): Promise<{ code: string; name: string }[]> {
  if (bankCache && Date.now() - bankCache.at < DAY) return bankCache.banks
  const data = await call('GET', '/banks/paystack')
  const banks = ((data?.banks ?? []) as any[])
    .map((b) => ({ code: String(b.code), name: String(b.name) }))
    .filter((b) => b.code && b.name)
    .sort((a, b) => a.name.localeCompare(b.name))
  bankCache = { at: Date.now(), banks }
  return banks
}

/** The account holder's name for an account number at a bank. */
export async function resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string; bankName: string }> {
  const k = `${bankCode}:${accountNumber}`
  const hit = resolveCache.get(k)
  if (hit && Date.now() - hit.at < DAY) return { accountName: hit.name, bankName: hit.bankName }
  let data: any
  try {
    data = await call('GET', `/banks/paystack/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`)
  } catch (e) {
    if (e instanceof TwelveAiError && e.status < 500) {
      throw new TwelveAiError('We could not find that account. Check the number and the bank.', 422)
    }
    throw e
  }
  const name = String(data?.account_name ?? '').trim()
  if (!name) throw new TwelveAiError('We could not find that account. Check the number and the bank.', 422)
  if (resolveCache.size > 5000) resolveCache.clear()
  resolveCache.set(k, { at: Date.now(), name, bankName: String(data?.bank_name ?? '') })
  return { accountName: name, bankName: String(data?.bank_name ?? '') }
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                             */
/* ------------------------------------------------------------------ */

/**
 * x-twelveai-signature = hex HMAC-SHA512(signing secret, raw body), and the
 * timestamp must be within five minutes. False when no secret is set.
 */
export function verifyTwelveAiSignature(
  raw: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string | null | undefined
): boolean {
  if (!secret) return false
  const sig = String(headers['x-twelveai-signature'] ?? '')
  const ts = Number(headers['x-twelveai-timestamp'] ?? 0)
  if (!sig) return false
  if (ts && Math.abs(Date.now() / 1000 - ts) > 300) return false
  const expected = createHmac('sha512', secret).update(raw).digest('hex')
  try {
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  } catch {
    return false
  }
}
