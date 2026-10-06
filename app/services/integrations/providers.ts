import { normalizePhone } from '#services/whatsapp'

/**
 * Provider registry for a school's own messaging accounts.
 *
 * Each provider declares the fields an admin fills in (secret fields are
 * stored encrypted), how to verify the credentials, how to send, and how to
 * read its delivery-report webhook. The rest of the app only talks to the
 * `ProviderAdapter` shape, never to a vendor's wire format.
 */

export type Kind = 'sms' | 'email' | 'whatsapp'

export interface FieldDef {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
  options?: { value: string; label: string }[]
}

export interface ProviderDef {
  key: string
  kind: Kind
  name: string
  blurb: string
  website: string
  fields: FieldDef[]
  /** True when the provider can POST delivery reports to our webhook URL. */
  deliveryReports: boolean
  /** Short setup note shown next to the webhook URL. */
  webhookNote?: string
}

export interface ProviderCtx {
  config: Record<string, any>
  secrets: Record<string, any>
  /** Public URL the provider should call back with delivery reports. */
  hookUrl: string
  schoolName: string
}

export interface OutboundMessage {
  to: string
  subject?: string | null
  body: string
  html?: string | null
}

export interface SendResult {
  providerMessageId: string | null
}

export interface DeliveryUpdate {
  providerMessageId: string
  status: 'sent' | 'delivered' | 'failed'
  error?: string | null
}

export interface ProviderAdapter {
  def: ProviderDef
  test(ctx: ProviderCtx): Promise<string>
  send(ctx: ProviderCtx, msg: OutboundMessage): Promise<SendResult>
  parseWebhook?(body: any, headers: Record<string, string | undefined>): DeliveryUpdate[]
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const TIMEOUT_MS = 15_000

async function http(url: string, init: RequestInit & { label: string }): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
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
      const detail =
        json?.message || json?.error?.message || json?.errors?.[0]?.message || json?.error || text.slice(0, 200)
      throw new Error(`${init.label}: ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.trim())
    }
    return { status: res.status, json, text, headers: res.headers }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${init.label}: timed out`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function basic(user: string, pass: string) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

function form(data: Record<string, string>) {
  return new URLSearchParams(data).toString()
}

/** E.164 with a leading '+', using Nigerian local-number rules. */
export function e164(raw: string): string {
  return '+' + normalizePhone(raw)
}

function req(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!s) throw new Error(`${label} is required`)
  return s
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Plain text to a minimal, readable HTML email. */
export function textToHtml(body: string, schoolName: string): string {
  const paras = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
  return `<!doctype html><html><body style="margin:0;background:#f7f8fb;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:14px">
<tr><td style="padding:26px 28px 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:600">${escapeHtml(schoolName)}</td></tr>
<tr><td style="padding:6px 28px 20px;font-size:15px">${paras}</td></tr>
</table></td></tr></table></body></html>`
}

/* ------------------------------------------------------------------ */
/* SMS                                                                 */
/* ------------------------------------------------------------------ */

const twilioSms: ProviderAdapter = {
  def: {
    key: 'twilio',
    kind: 'sms',
    name: 'Twilio',
    blurb: 'Global SMS with delivery reports. Works with a Twilio number or an approved alphanumeric sender.',
    website: 'https://www.twilio.com',
    deliveryReports: true,
    webhookNote: 'Set automatically on every message. Nothing to configure in Twilio.',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC...' },
      { key: 'authToken', label: 'Auth token', secret: true, required: true },
      { key: 'from', label: 'From (number or sender ID)', required: true, placeholder: '+1415... or SCHOOL', help: 'A Twilio number in E.164, or an approved alphanumeric sender ID.' },
    ],
  },
  async test({ config, secrets }) {
    const sid = req(config.accountSid, 'Account SID')
    const { json } = await http(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      label: 'Twilio',
      headers: { Authorization: basic(sid, req(secrets.authToken, 'Auth token')) },
    })
    return `Connected to ${json?.friendly_name ?? 'Twilio account'} (${json?.status ?? 'active'})`
  },
  async send({ config, secrets, hookUrl }, msg) {
    const sid = req(config.accountSid, 'Account SID')
    const { json } = await http(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      label: 'Twilio',
      method: 'POST',
      headers: {
        'Authorization': basic(sid, req(secrets.authToken, 'Auth token')),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form({ From: req(config.from, 'From'), To: e164(msg.to), Body: msg.body, StatusCallback: hookUrl }),
    })
    return { providerMessageId: json?.sid ?? null }
  },
  parseWebhook(body) {
    const id = body?.MessageSid ?? body?.SmsSid
    const s = String(body?.MessageStatus ?? body?.SmsStatus ?? '').toLowerCase()
    if (!id || !s) return []
    if (s === 'delivered' || s === 'read') return [{ providerMessageId: id, status: 'delivered' }]
    if (s === 'failed' || s === 'undelivered')
      return [{ providerMessageId: id, status: 'failed', error: body?.ErrorCode ? `Twilio error ${body.ErrorCode}` : s }]
    return []
  },
}

const termii: ProviderAdapter = {
  def: {
    key: 'termii',
    kind: 'sms',
    name: 'Termii',
    blurb: 'Nigerian SMS gateway. Use the DND route so messages reach numbers on Do-Not-Disturb.',
    website: 'https://termii.com',
    deliveryReports: true,
    webhookNote: 'In Termii, go to Settings, Webhooks and paste this URL to receive delivery reports.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'senderId', label: 'Sender ID', required: true, placeholder: 'MySchool', help: 'Must be approved in your Termii dashboard.' },
      {
        key: 'channel',
        label: 'Route',
        options: [
          { value: 'dnd', label: 'DND (recommended for schools)' },
          { value: 'generic', label: 'Generic' },
        ],
      },
      { key: 'baseUrl', label: 'API base URL', placeholder: 'https://api.ng.termii.com', help: 'Leave blank unless Termii gave you a different base URL.' },
    ],
  },
  async test({ config, secrets }) {
    const base = String(config.baseUrl || 'https://api.ng.termii.com').replace(/\/$/, '')
    const { json } = await http(`${base}/api/get-balance?api_key=${encodeURIComponent(req(secrets.apiKey, 'API key'))}`, { label: 'Termii' })
    return `Connected. Balance: ${json?.currency ?? ''} ${json?.balance ?? 'unknown'}`.trim()
  },
  async send({ config, secrets }, msg) {
    const base = String(config.baseUrl || 'https://api.ng.termii.com').replace(/\/$/, '')
    const { json } = await http(`${base}/api/sms/send`, {
      label: 'Termii',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: req(secrets.apiKey, 'API key'),
        to: normalizePhone(msg.to),
        from: req(config.senderId, 'Sender ID'),
        sms: msg.body,
        type: 'plain',
        channel: config.channel === 'generic' ? 'generic' : 'dnd',
      }),
    })
    return { providerMessageId: json?.message_id ? String(json.message_id) : null }
  },
  parseWebhook(body) {
    const id = body?.message_id ?? body?.id
    const s = String(body?.status ?? '').toLowerCase()
    if (!id || !s) return []
    if (s.includes('delivered')) return [{ providerMessageId: String(id), status: 'delivered' }]
    if (s.includes('fail') || s.includes('reject') || s.includes('expired') || s.includes('dnd'))
      return [{ providerMessageId: String(id), status: 'failed', error: body.status }]
    return []
  },
}

const africasTalking: ProviderAdapter = {
  def: {
    key: 'africastalking',
    kind: 'sms',
    name: "Africa's Talking",
    blurb: 'Pan-African SMS with local routes and delivery reports.',
    website: 'https://africastalking.com',
    deliveryReports: true,
    webhookNote: 'In your Africa\'s Talking app, open SMS, Callback URLs, Delivery Reports and paste this URL.',
    fields: [
      { key: 'username', label: 'Username', required: true, help: 'Use "sandbox" for the sandbox.' },
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'from', label: 'Sender ID or short code', placeholder: 'Optional' },
    ],
  },
  async test({ config, secrets }) {
    const username = req(config.username, 'Username')
    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com'
    const { json } = await http(`https://${host}/version1/user?username=${encodeURIComponent(username)}`, {
      label: "Africa's Talking",
      headers: { apiKey: req(secrets.apiKey, 'API key'), Accept: 'application/json' },
    })
    return `Connected. Balance: ${json?.UserData?.balance ?? 'unknown'}`
  },
  async send({ config, secrets }, msg) {
    const username = req(config.username, 'Username')
    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com'
    const data: Record<string, string> = { username, to: e164(msg.to), message: msg.body }
    if (config.from) data.from = String(config.from)
    const { json } = await http(`https://${host}/version1/messaging`, {
      label: "Africa's Talking",
      method: 'POST',
      headers: {
        'apiKey': req(secrets.apiKey, 'API key'),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form(data),
    })
    const r = json?.SMSMessageData?.Recipients?.[0]
    if (r && r.statusCode && Number(r.statusCode) >= 400) throw new Error(`Africa's Talking: ${r.status}`)
    return { providerMessageId: r?.messageId ?? null }
  },
  parseWebhook(body) {
    const id = body?.id
    const s = String(body?.status ?? '').toLowerCase()
    if (!id || !s) return []
    if (s === 'success') return [{ providerMessageId: id, status: 'delivered' }]
    if (s === 'failed' || s === 'rejected') return [{ providerMessageId: id, status: 'failed', error: body?.failureReason ?? body.status }]
    return []
  },
}

const bulkSmsNigeria: ProviderAdapter = {
  def: {
    key: 'bulksmsnigeria',
    kind: 'sms',
    name: 'BulkSMSNigeria',
    blurb: 'Low-cost Nigerian bulk SMS. Delivery reports are viewed in their dashboard.',
    website: 'https://www.bulksmsnigeria.com',
    deliveryReports: false,
    fields: [
      { key: 'apiToken', label: 'API token', secret: true, required: true },
      { key: 'from', label: 'Sender name', required: true, placeholder: 'MySchool' },
    ],
  },
  async test({ secrets }) {
    req(secrets.apiToken, 'API token')
    return 'Saved. Send a test message to confirm the token works.'
  },
  async send({ config, secrets }, msg) {
    const { json } = await http('https://www.bulksmsnigeria.com/api/v2/sms', {
      label: 'BulkSMSNigeria',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        api_token: req(secrets.apiToken, 'API token'),
        from: req(config.from, 'Sender name'),
        to: normalizePhone(msg.to),
        body: msg.body,
      }),
    })
    const status = String(json?.data?.status ?? json?.status ?? '').toLowerCase()
    if (status && status !== 'success' && status !== 'ok') throw new Error(`BulkSMSNigeria: ${json?.data?.message ?? json?.message ?? status}`)
    return { providerMessageId: json?.data?.message_id ? String(json.data.message_id) : null }
  },
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function fromHeader(config: Record<string, any>, schoolName: string) {
  const addr = req(config.fromEmail, 'From email')
  const name = String(config.fromName || schoolName).replace(/[<>"]/g, '')
  return { addr, name, header: `${name} <${addr}>` }
}

const sendgrid: ProviderAdapter = {
  def: {
    key: 'sendgrid',
    kind: 'email',
    name: 'SendGrid',
    blurb: 'Twilio SendGrid transactional email with delivery and bounce events.',
    website: 'https://sendgrid.com',
    deliveryReports: true,
    webhookNote: 'In SendGrid, open Settings, Mail Settings, Event Webhook. Paste this URL and tick Delivered, Bounced and Dropped.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'SG...' },
      { key: 'fromEmail', label: 'From email', required: true, placeholder: 'info@myschool.ng', help: 'Must be a verified sender or domain in SendGrid.' },
      { key: 'fromName', label: 'From name', placeholder: 'Defaults to the school name' },
    ],
  },
  async test({ secrets }) {
    const { json } = await http('https://api.sendgrid.com/v3/scopes', {
      label: 'SendGrid',
      headers: { Authorization: `Bearer ${req(secrets.apiKey, 'API key')}` },
    })
    const scopes: string[] = json?.scopes ?? []
    if (!scopes.includes('mail.send')) throw new Error('SendGrid: this key cannot send mail (missing mail.send scope)')
    return 'Connected. Key can send mail.'
  },
  async send({ config, secrets, schoolName }, msg) {
    const from = fromHeader(config, schoolName)
    const { headers } = await http('https://api.sendgrid.com/v3/mail/send', {
      label: 'SendGrid',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.apiKey, 'API key')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from.addr, name: from.name },
        subject: msg.subject || schoolName,
        content: [
          { type: 'text/plain', value: msg.body },
          { type: 'text/html', value: msg.html || textToHtml(msg.body, schoolName) },
        ],
      }),
    })
    return { providerMessageId: headers.get('x-message-id') }
  },
  parseWebhook(body) {
    const events = Array.isArray(body) ? body : []
    const out: DeliveryUpdate[] = []
    for (const ev of events) {
      const id = String(ev?.sg_message_id ?? '').split('.')[0]
      if (!id) continue
      if (ev.event === 'delivered') out.push({ providerMessageId: id, status: 'delivered' })
      else if (ev.event === 'bounce' || ev.event === 'dropped')
        out.push({ providerMessageId: id, status: 'failed', error: ev.reason ?? ev.event })
    }
    return out
  },
}

const mailgun: ProviderAdapter = {
  def: {
    key: 'mailgun',
    kind: 'email',
    name: 'Mailgun',
    blurb: 'Email API with delivery and failure webhooks. US and EU regions.',
    website: 'https://www.mailgun.com',
    deliveryReports: true,
    webhookNote: 'In Mailgun, open Sending, Webhooks for your domain and add this URL for Delivered and Permanent failure.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'domain', label: 'Sending domain', required: true, placeholder: 'mg.myschool.ng' },
      {
        key: 'region',
        label: 'Region',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' },
        ],
      },
      { key: 'fromEmail', label: 'From email', required: true, placeholder: 'info@mg.myschool.ng' },
      { key: 'fromName', label: 'From name', placeholder: 'Defaults to the school name' },
    ],
  },
  async test({ config, secrets }) {
    const host = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
    const domain = req(config.domain, 'Sending domain')
    const { json } = await http(`https://${host}/v3/domains/${encodeURIComponent(domain)}`, {
      label: 'Mailgun',
      headers: { Authorization: basic('api', req(secrets.apiKey, 'API key')) },
    })
    return `Connected. Domain ${domain} is ${json?.domain?.state ?? 'found'}.`
  },
  async send({ config, secrets, schoolName }, msg) {
    const host = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
    const from = fromHeader(config, schoolName)
    const { json } = await http(`https://${host}/v3/${encodeURIComponent(req(config.domain, 'Sending domain'))}/messages`, {
      label: 'Mailgun',
      method: 'POST',
      headers: {
        'Authorization': basic('api', req(secrets.apiKey, 'API key')),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form({
        from: from.header,
        to: msg.to,
        subject: msg.subject || schoolName,
        text: msg.body,
        html: msg.html || textToHtml(msg.body, schoolName),
      }),
    })
    return { providerMessageId: json?.id ? String(json.id).replace(/[<>]/g, '') : null }
  },
  parseWebhook(body) {
    const ev = body?.['event-data']
    const id = ev?.message?.headers?.['message-id']
    if (!ev || !id) return []
    if (ev.event === 'delivered') return [{ providerMessageId: id, status: 'delivered' }]
    if (ev.event === 'failed' && ev.severity !== 'temporary')
      return [{ providerMessageId: id, status: 'failed', error: ev['delivery-status']?.message ?? ev.reason ?? 'failed' }]
    return []
  },
}

const resend: ProviderAdapter = {
  def: {
    key: 'resend',
    kind: 'email',
    name: 'Resend',
    blurb: 'Developer-friendly email API with delivery and bounce webhooks.',
    website: 'https://resend.com',
    deliveryReports: true,
    webhookNote: 'In Resend, open Webhooks, add this URL and select email.delivered and email.bounced.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 're_...' },
      { key: 'fromEmail', label: 'From email', required: true, placeholder: 'info@myschool.ng', help: 'Must be on a domain verified in Resend.' },
      { key: 'fromName', label: 'From name', placeholder: 'Defaults to the school name' },
    ],
  },
  async test({ secrets }) {
    const { json } = await http('https://api.resend.com/domains', {
      label: 'Resend',
      headers: { Authorization: `Bearer ${req(secrets.apiKey, 'API key')}` },
    })
    const n = Array.isArray(json?.data) ? json.data.length : 0
    return `Connected. ${n} domain${n === 1 ? '' : 's'} on the account.`
  },
  async send({ config, secrets, schoolName }, msg) {
    const from = fromHeader(config, schoolName)
    const { json } = await http('https://api.resend.com/emails', {
      label: 'Resend',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.apiKey, 'API key')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from.header,
        to: [msg.to],
        subject: msg.subject || schoolName,
        text: msg.body,
        html: msg.html || textToHtml(msg.body, schoolName),
      }),
    })
    return { providerMessageId: json?.id ?? null }
  },
  parseWebhook(body) {
    const id = body?.data?.email_id
    if (!id) return []
    if (body.type === 'email.delivered') return [{ providerMessageId: id, status: 'delivered' }]
    if (body.type === 'email.bounced' || body.type === 'email.failed')
      return [{ providerMessageId: id, status: 'failed', error: body.data?.bounce?.message ?? body.type }]
    return []
  },
}

const postmark: ProviderAdapter = {
  def: {
    key: 'postmark',
    kind: 'email',
    name: 'Postmark',
    blurb: 'Fast transactional email with delivery and bounce webhooks.',
    website: 'https://postmarkapp.com',
    deliveryReports: true,
    webhookNote: 'In Postmark, open your server, Webhooks, add this URL and enable Delivery and Bounce.',
    fields: [
      { key: 'serverToken', label: 'Server API token', secret: true, required: true },
      { key: 'fromEmail', label: 'From email', required: true, placeholder: 'info@myschool.ng', help: 'Must be a confirmed sender signature or domain.' },
      { key: 'fromName', label: 'From name', placeholder: 'Defaults to the school name' },
    ],
  },
  async test({ secrets }) {
    const { json } = await http('https://api.postmarkapp.com/server', {
      label: 'Postmark',
      headers: { 'X-Postmark-Server-Token': req(secrets.serverToken, 'Server API token'), 'Accept': 'application/json' },
    })
    return `Connected to server "${json?.Name ?? 'Postmark'}".`
  },
  async send({ config, secrets, schoolName }, msg) {
    const from = fromHeader(config, schoolName)
    const { json } = await http('https://api.postmarkapp.com/email', {
      label: 'Postmark',
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': req(secrets.serverToken, 'Server API token'),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        From: from.header,
        To: msg.to,
        Subject: msg.subject || schoolName,
        TextBody: msg.body,
        HtmlBody: msg.html || textToHtml(msg.body, schoolName),
        MessageStream: 'outbound',
      }),
    })
    return { providerMessageId: json?.MessageID ?? null }
  },
  parseWebhook(body) {
    const id = body?.MessageID
    if (!id) return []
    if (body.RecordType === 'Delivery') return [{ providerMessageId: id, status: 'delivered' }]
    if (body.RecordType === 'Bounce') return [{ providerMessageId: id, status: 'failed', error: body.Description ?? body.Type }]
    return []
  },
}

const smtp: ProviderAdapter = {
  def: {
    key: 'smtp',
    kind: 'email',
    name: 'Custom SMTP',
    blurb: 'Send through any mail server: Google Workspace, Microsoft 365, Zoho or your host.',
    website: 'https://en.wikipedia.org/wiki/Simple_Mail_Transfer_Protocol',
    deliveryReports: false,
    fields: [
      { key: 'host', label: 'SMTP host', required: true, placeholder: 'smtp.gmail.com' },
      { key: 'port', label: 'Port', required: true, placeholder: '587' },
      {
        key: 'security',
        label: 'Security',
        options: [
          { value: 'starttls', label: 'STARTTLS (port 587)' },
          { value: 'ssl', label: 'SSL/TLS (port 465)' },
          { value: 'none', label: 'None' },
        ],
      },
      { key: 'username', label: 'Username', required: true },
      { key: 'password', label: 'Password or app password', secret: true, required: true },
      { key: 'fromEmail', label: 'From email', required: true },
      { key: 'fromName', label: 'From name', placeholder: 'Defaults to the school name' },
    ],
  },
  async test(ctx) {
    const t = await smtpTransport(ctx)
    await t.verify()
    t.close()
    return 'Connected. The mail server accepted the login.'
  },
  async send(ctx, msg) {
    const t = await smtpTransport(ctx)
    try {
      const from = fromHeader(ctx.config, ctx.schoolName)
      const info = await t.sendMail({
        from: { name: from.name, address: from.addr },
        to: msg.to,
        subject: msg.subject || ctx.schoolName,
        text: msg.body,
        html: msg.html || textToHtml(msg.body, ctx.schoolName),
      })
      return { providerMessageId: info.messageId ?? null }
    } finally {
      t.close()
    }
  },
}

async function smtpTransport({ config, secrets }: ProviderCtx) {
  const nodemailer = (await import('nodemailer')).default
  const port = Number(req(config.port, 'Port'))
  return nodemailer.createTransport({
    host: req(config.host, 'SMTP host'),
    port,
    secure: config.security === 'ssl' || (config.security == null && port === 465),
    ignoreTLS: config.security === 'none',
    auth: { user: req(config.username, 'Username'), pass: req(secrets.password, 'Password') },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
  })
}

/* ------------------------------------------------------------------ */
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */

const metaWhatsapp: ProviderAdapter = {
  def: {
    key: 'meta_whatsapp',
    kind: 'whatsapp',
    name: 'WhatsApp Business (Meta)',
    blurb: "The school's own WhatsApp number through Meta's Cloud API. Alerts use an approved template.",
    website: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    deliveryReports: true,
    webhookNote:
      'In your Meta app, open WhatsApp, Configuration. Set this as the Callback URL, use the same token (the last part of the URL) as the Verify token, and subscribe to "messages".',
    fields: [
      { key: 'accessToken', label: 'Permanent access token', secret: true, required: true },
      { key: 'phoneNumberId', label: 'Phone number ID', required: true },
      {
        key: 'templateName',
        label: 'Template name',
        placeholder: 'school_update',
        help: 'An approved template with one variable, for example "Update from your school: {{1}}". Without it, WhatsApp only delivers to people who messaged you in the last 24 hours.',
      },
      { key: 'templateLanguage', label: 'Template language', placeholder: 'en' },
    ],
  },
  async test({ config, secrets }) {
    const id = req(config.phoneNumberId, 'Phone number ID')
    const { json } = await http(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}?fields=display_phone_number,verified_name`, {
      label: 'WhatsApp',
      headers: { Authorization: `Bearer ${req(secrets.accessToken, 'Access token')}` },
    })
    return `Connected to ${json?.verified_name ?? 'WhatsApp'} (${json?.display_phone_number ?? id}).`
  },
  async send({ config, secrets }, msg) {
    const id = req(config.phoneNumberId, 'Phone number ID')
    const text = msg.body.length > 1000 ? msg.body.slice(0, 997) + '...' : msg.body
    const payload = config.templateName
      ? {
          messaging_product: 'whatsapp',
          to: normalizePhone(msg.to),
          type: 'template',
          template: {
            name: String(config.templateName),
            language: { code: String(config.templateLanguage || 'en') },
            components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' ') }] }],
          },
        }
      : { messaging_product: 'whatsapp', to: normalizePhone(msg.to), type: 'text', text: { body: text } }
    const { json } = await http(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}/messages`, {
      label: 'WhatsApp',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${req(secrets.accessToken, 'Access token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { providerMessageId: json?.messages?.[0]?.id ?? null }
  },
  parseWebhook(body) {
    const out: DeliveryUpdate[] = []
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const st of change?.value?.statuses ?? []) {
          if (st.status === 'delivered' || st.status === 'read') out.push({ providerMessageId: st.id, status: 'delivered' })
          else if (st.status === 'failed')
            out.push({ providerMessageId: st.id, status: 'failed', error: st.errors?.[0]?.title ?? 'failed' })
        }
      }
    }
    return out
  },
}

const twilioWhatsapp: ProviderAdapter = {
  def: {
    key: 'twilio_whatsapp',
    kind: 'whatsapp',
    name: 'WhatsApp via Twilio',
    blurb: 'Send WhatsApp messages through a Twilio WhatsApp sender, with delivery reports.',
    website: 'https://www.twilio.com/whatsapp',
    deliveryReports: true,
    webhookNote: 'Set automatically on every message. Nothing to configure in Twilio.',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC...' },
      { key: 'authToken', label: 'Auth token', secret: true, required: true },
      { key: 'from', label: 'WhatsApp sender number', required: true, placeholder: '+14155238886' },
    ],
  },
  test: twilioSms.test,
  async send({ config, secrets, hookUrl }, msg) {
    const sid = req(config.accountSid, 'Account SID')
    const fromNum = req(config.from, 'Sender').replace(/^whatsapp:/, '')
    const { json } = await http(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      label: 'Twilio WhatsApp',
      method: 'POST',
      headers: {
        'Authorization': basic(sid, req(secrets.authToken, 'Auth token')),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form({ From: `whatsapp:${fromNum}`, To: `whatsapp:${e164(msg.to)}`, Body: msg.body, StatusCallback: hookUrl }),
    })
    return { providerMessageId: json?.sid ?? null }
  },
  parseWebhook: twilioSms.parseWebhook,
}

/* ------------------------------------------------------------------ */

export const PROVIDERS: ProviderAdapter[] = [
  termii,
  twilioSms,
  africasTalking,
  bulkSmsNigeria,
  sendgrid,
  mailgun,
  resend,
  postmark,
  smtp,
  metaWhatsapp,
  twilioWhatsapp,
]

export function providerFor(key: string): ProviderAdapter | undefined {
  return PROVIDERS.find((p) => p.def.key === key)
}
