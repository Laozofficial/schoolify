import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ProviderCtx, ProviderDef } from '#services/integrations/providers'

/**
 * Non-messaging connections: online meetings (Zoom) and the school's own
 * payment account (Paystack, Flutterwave). They share the connection store
 * (encrypted secrets, per-connection webhook URL) with messaging providers.
 */

export type ExtraKind = 'meetings' | 'payments'

export interface ExtraDef extends Omit<ProviderDef, 'kind'> {
  kind: ExtraKind
}

async function http(url: string, init: RequestInit & { label: string }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const msg = json?.message || json?.reason || json?.error || text.slice(0, 200)
      throw new Error(`${init.label}: ${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
    }
    return json
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${init.label}: timed out`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function req(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!s) throw new Error(`${label} is required`)
  return s
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

export interface MeetingAdapter {
  def: ExtraDef
  test(ctx: ProviderCtx): Promise<string>
  createMeeting(ctx: ProviderCtx, m: { topic: string; startIso: string; durationMinutes: number; agenda?: string | null }): Promise<{ joinUrl: string; id: string }>
}

async function zoomToken({ config, secrets }: ProviderCtx): Promise<string> {
  const id = req(config.clientId, 'Client ID')
  const secret = req(secrets.clientSecret, 'Client secret')
  const json = await http(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(req(config.accountId, 'Account ID'))}`, {
    label: 'Zoom',
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
  })
  return json.access_token
}

export const zoom: MeetingAdapter = {
  def: {
    key: 'zoom',
    kind: 'meetings',
    name: 'Zoom',
    blurb: 'Create Zoom meetings for online classes, PTA meetings and staff briefings straight from the calendar.',
    website: 'https://marketplace.zoom.us/develop/create',
    deliveryReports: false,
    fields: [
      { key: 'accountId', label: 'Account ID', required: true, help: 'From a Server-to-Server OAuth app in the Zoom Marketplace.' },
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
      { key: 'hostEmail', label: 'Host email', placeholder: 'Leave blank to use the app owner', help: 'Meetings are created under this Zoom user.' },
    ],
  },
  async test(ctx) {
    const token = await zoomToken(ctx)
    const user = String(ctx.config.hostEmail || 'me')
    const json = await http(`https://api.zoom.us/v2/users/${encodeURIComponent(user)}`, { label: 'Zoom', headers: { Authorization: `Bearer ${token}` } })
    return `Connected. Meetings will be hosted by ${json?.email ?? user}.`
  },
  async createMeeting(ctx, m) {
    const token = await zoomToken(ctx)
    const user = String(ctx.config.hostEmail || 'me')
    const json = await http(`https://api.zoom.us/v2/users/${encodeURIComponent(user)}/meetings`, {
      label: 'Zoom',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: m.topic.slice(0, 200),
        type: 2,
        start_time: m.startIso,
        duration: m.durationMinutes,
        timezone: 'Africa/Lagos',
        agenda: m.agenda?.slice(0, 2000) ?? undefined,
        settings: { join_before_host: false, waiting_room: true },
      }),
    })
    return { joinUrl: json.join_url, id: String(json.id) }
  },
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface PaymentAdapter {
  def: ExtraDef
  test(ctx: ProviderCtx): Promise<string>
  initialize(ctx: ProviderCtx, p: { amountKobo: number; email: string; reference: string; callbackUrl: string; metadata: Record<string, unknown> }): Promise<{ authorizationUrl: string }>
  /** Returns false when the request did not come from the provider. */
  verifyWebhook(ctx: ProviderCtx, raw: string, headers: Record<string, string | undefined>): boolean
  /** Reference of a successful charge in a webhook body, if any. */
  successReference(body: any): string | null
  /** Ask the provider for the truth about a reference. */
  verify(ctx: ProviderCtx, reference: string): Promise<{ success: boolean; amountKobo: number }>
}

export const paystack: PaymentAdapter = {
  def: {
    key: 'paystack',
    kind: 'payments',
    name: 'Paystack',
    blurb: "Collect fees online into the school's own Paystack account: cards, bank transfer and USSD.",
    website: 'https://dashboard.paystack.com/#/settings/developers',
    deliveryReports: true,
    webhookNote: 'In Paystack, open Settings, API Keys and Webhooks, and paste this as the Webhook URL.',
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true, required: true, placeholder: 'sk_live_...' },
      { key: 'publicKey', label: 'Public key', placeholder: 'pk_live_...' },
    ],
  },
  async test({ secrets }) {
    const key = req(secrets.secretKey, 'Secret key')
    await http('https://api.paystack.co/balance', { label: 'Paystack', headers: { Authorization: `Bearer ${key}` } })
    return key.startsWith('sk_test') ? 'Connected in TEST mode. No real money will move.' : 'Connected. Online fee payments go to your Paystack account.'
  },
  async initialize({ secrets }, p) {
    const json = await http('https://api.paystack.co/transaction/initialize', {
      label: 'Paystack',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.secretKey, 'Secret key')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: p.email, amount: p.amountKobo, reference: p.reference, callback_url: p.callbackUrl, metadata: p.metadata }),
    })
    return { authorizationUrl: json?.data?.authorization_url }
  },
  verifyWebhook({ secrets }, raw, headers) {
    const sig = headers['x-paystack-signature'] ?? ''
    const key = String(secrets.secretKey ?? '')
    if (!sig || !key) return false
    const expected = createHmac('sha512', key).update(raw).digest('hex')
    try {
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch {
      return false
    }
  },
  successReference(body) {
    return body?.event === 'charge.success' && body?.data?.reference ? String(body.data.reference) : null
  },
  async verify({ secrets }, reference) {
    const json = await http(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      label: 'Paystack',
      headers: { Authorization: `Bearer ${req(secrets.secretKey, 'Secret key')}` },
    })
    return { success: json?.data?.status === 'success', amountKobo: Math.round(Number(json?.data?.amount ?? 0)) }
  },
}

export const flutterwave: PaymentAdapter = {
  def: {
    key: 'flutterwave',
    kind: 'payments',
    name: 'Flutterwave',
    blurb: "Collect fees online into the school's own Flutterwave account: cards, transfer, USSD and mobile money.",
    website: 'https://app.flutterwave.com/dashboard/settings/apis',
    deliveryReports: true,
    webhookNote: 'In Flutterwave, open Settings, Webhooks. Paste this URL and set the Secret hash to the same value you enter here.',
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true, required: true, placeholder: 'FLWSECK-...' },
      { key: 'webhookHash', label: 'Webhook secret hash', secret: true, required: true, help: 'Any long random text. Enter the same value in Flutterwave.' },
    ],
  },
  async test({ secrets }) {
    const key = req(secrets.secretKey, 'Secret key')
    await http('https://api.flutterwave.com/v3/balances/NGN', { label: 'Flutterwave', headers: { Authorization: `Bearer ${key}` } })
    return key.includes('_TEST') ? 'Connected in TEST mode. No real money will move.' : 'Connected. Online fee payments go to your Flutterwave account.'
  },
  async initialize({ secrets }, p) {
    const json = await http('https://api.flutterwave.com/v3/payments', {
      label: 'Flutterwave',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.secretKey, 'Secret key')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref: p.reference,
        amount: (p.amountKobo / 100).toFixed(2),
        currency: 'NGN',
        redirect_url: p.callbackUrl,
        customer: { email: p.email },
        meta: p.metadata,
      }),
    })
    return { authorizationUrl: json?.data?.link }
  },
  verifyWebhook({ secrets }, _raw, headers) {
    const got = headers['verif-hash'] ?? ''
    const want = String(secrets.webhookHash ?? '')
    if (!got || !want) return false
    try {
      return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
    } catch {
      return false
    }
  },
  successReference(body) {
    const d = body?.data ?? body
    const ok = (body?.event === 'charge.completed' || body?.['event.type']) && String(d?.status).toLowerCase() === 'successful'
    return ok && d?.tx_ref ? String(d.tx_ref) : null
  },
  async verify({ secrets }, reference) {
    const json = await http(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
      label: 'Flutterwave',
      headers: { Authorization: `Bearer ${req(secrets.secretKey, 'Secret key')}` },
    })
    const d = json?.data
    return { success: String(d?.status).toLowerCase() === 'successful' && d?.currency === 'NGN', amountKobo: Math.round(Number(d?.amount ?? 0) * 100) }
  },
}

const TWELVEAI_API = 'https://api.twelveai.app/api/business/v1'

export const twelveai: PaymentAdapter = {
  def: {
    key: 'twelveai',
    kind: 'payments',
    name: 'TwelveAI Business',
    blurb: "Collect fees online into the school's own TwelveAI Business account: cards, bank transfer and USSD.",
    website: 'https://business.twelveai.app',
    deliveryReports: true,
    webhookNote: 'In TwelveAI Business, open Developers, Webhooks. Paste this URL, generate a signing secret and paste that secret here.',
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true, required: true, placeholder: 'tw_live_...' },
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true, placeholder: 'whsec_...' },
    ],
  },
  async test({ secrets }) {
    const key = req(secrets.secretKey, 'Secret key')
    await http(`${TWELVEAI_API}/balance`, { label: 'TwelveAI Business', headers: { Authorization: `Bearer ${key}` } })
    return /^(tw|sk)_test_/.test(key) ? 'Connected in TEST mode. No real money will move.' : 'Connected. Online fee payments go to your TwelveAI Business account.'
  },
  async initialize({ secrets }, p) {
    const json = await http(`${TWELVEAI_API}/payments/initialize`, {
      label: 'TwelveAI Business',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.secretKey, 'Secret key')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: p.email, amount: p.amountKobo, reference: p.reference, callback_url: p.callbackUrl, metadata: p.metadata }),
    })
    return { authorizationUrl: json?.data?.checkout_url ?? json?.data?.authorization_url }
  },
  verifyWebhook({ secrets }, raw, headers) {
    const sig = headers['x-twelveai-signature'] ?? ''
    const key = String(secrets.webhookSecret ?? '')
    if (!sig || !key) return false
    const ts = Number(headers['x-twelveai-timestamp'] ?? 0)
    if (ts && Math.abs(Date.now() / 1000 - ts) > 300) return false
    const expected = createHmac('sha512', key).update(raw).digest('hex')
    try {
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch {
      return false
    }
  },
  successReference(body) {
    return body?.event === 'charge.success' && body?.data?.reference ? String(body.data.reference) : null
  },
  async verify({ secrets }, reference) {
    const json = await http(`${TWELVEAI_API}/payments/verify/${encodeURIComponent(reference)}`, {
      label: 'TwelveAI Business',
      headers: { Authorization: `Bearer ${req(secrets.secretKey, 'Secret key')}` },
    })
    const st = String(json?.data?.status ?? '').toLowerCase()
    // Gross paid; recordOnlinePayment never applies more than the invoice owes, so a fee passed to the parent cannot over-credit it.
    return { success: st === 'successful' || st === 'success', amountKobo: Math.round(Number(json?.data?.amount ?? 0)) }
  },
}

export const MEETING_PROVIDERS: MeetingAdapter[] = [zoom]
export const PAYMENT_PROVIDERS: PaymentAdapter[] = [paystack, flutterwave, twelveai]

export function extraFor(key: string): MeetingAdapter | PaymentAdapter | undefined {
  return [...MEETING_PROVIDERS, ...PAYMENT_PROVIDERS].find((p) => p.def.key === key)
}
export function paymentFor(key: string) {
  return PAYMENT_PROVIDERS.find((p) => p.def.key === key)
}
export function meetingFor(key: string) {
  return MEETING_PROVIDERS.find((p) => p.def.key === key)
}
