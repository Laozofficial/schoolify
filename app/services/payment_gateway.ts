import { createHmac, timingSafeEqual } from 'node:crypto'
import env from '#start/env'

/**
 * Adapter for payment.twelveai.app.
 *
 * The exact request/response field names below follow the common
 * Paystack-style contract (init returns an authorization URL + reference;
 * verify returns a status + amount in kobo; webhooks are HMAC-SHA512
 * signed). When the real API keys + docs arrive, the ONLY things that
 * should need adjusting are the three mapping spots marked `MAP:` - the
 * rest of the app depends on this module's typed return shapes, not the
 * gateway's wire format.
 */

export interface InitInput {
  amountKobo: number
  email: string
  reference: string
  callbackUrl?: string
  metadata?: Record<string, unknown>
}
export interface InitResult {
  authorizationUrl: string
  reference: string
}
export interface VerifyResult {
  status: 'success' | 'failed' | 'pending'
  amountKobo: number
  reference: string
}

export function isPaymentConfigured(): boolean {
  return !!env.get('PAYMENT_SECRET_KEY') && !!baseUrl()
}

function baseUrl(): string {
  return (env.get('PAYMENT_BASE_URL') ?? 'https://payment.twelveai.app').replace(/\/$/, '')
}

function secret(): string {
  const s = env.get('PAYMENT_SECRET_KEY')
  if (!s) throw new Error('Payments not configured (missing PAYMENT_SECRET_KEY)')
  return s.release()
}

/** Start a checkout. Returns the URL to redirect the payer to. */
export async function initializePayment(input: InitInput): Promise<InitResult> {
  const res = await fetch(`${baseUrl()}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // MAP: request body -> gateway's expected fields
      amount: input.amountKobo,
      email: input.email,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    }),
  })
  const json = (await res.json()) as any
  if (!res.ok) {
    throw new Error(json?.message ?? `Gateway error (${res.status})`)
  }
  // MAP: gateway response -> InitResult
  return {
    authorizationUrl: json?.data?.authorization_url,
    reference: json?.data?.reference ?? input.reference,
  }
}

/** Confirm a transaction by reference (used on callback + as webhook backup). */
export async function verifyPayment(reference: string): Promise<VerifyResult> {
  const res = await fetch(
    `${baseUrl()}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secret()}` } }
  )
  const json = (await res.json()) as any
  if (!res.ok) throw new Error(json?.message ?? `Gateway error (${res.status})`)
  // MAP: gateway response -> VerifyResult
  const status = json?.data?.status
  return {
    status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
    amountKobo: Number(json?.data?.amount ?? 0),
    reference: json?.data?.reference ?? reference,
  }
}

/** Validate a webhook payload signature (HMAC-SHA512 of the raw body). */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const key = env.get('PAYMENT_WEBHOOK_SECRET') ?? env.get('PAYMENT_SECRET_KEY')
  if (!key) return false
  const expected = createHmac('sha512', key.release()).update(rawBody).digest('hex')
  try {
    return (
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
  } catch {
    return false
  }
}
