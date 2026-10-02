import { createHmac, timingSafeEqual } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

/**
 * Minimal WhatsApp Cloud API (Meta) client for the family assistant.
 * Outbound: text replies. Inbound: webhook signature verification.
 * When credentials are missing, sends are logged instead of delivered so
 * the inbound flow can still be exercised locally.
 */

export function isWhatsappConfigured(): boolean {
  return !!env.get('WHATSAPP_TOKEN')?.release() && !!env.get('WHATSAPP_PHONE_NUMBER_ID')
}

export function whatsappDisplayNumber(): string | null {
  const n = env.get('WHATSAPP_DISPLAY_NUMBER')
  return n ? n.replace(/\D/g, '') : null
}

/**
 * Normalise a phone to E.164 digits without '+'. Nigerian local formats
 * (080..., 80...) become 234...; anything else keeps its digits.
 */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('0')) d = '234' + d.slice(1)
  if (d.length === 10 && /^[789]/.test(d)) d = '234' + d
  return d
}

/** Mask all but the last 4 digits for display. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? phone : '+' + phone.slice(0, 3) + ' *** *** ' + phone.slice(-4)
}

export function verifyWhatsappSignature(rawBody: string, header: string | undefined): boolean {
  const secret = env.get('WHATSAPP_APP_SECRET')?.release()
  if (!secret || !header?.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))
  } catch {
    return false
  }
}

/** WhatsApp caps a text body at 4096 characters. */
const MAX_TEXT = 4000

export async function sendWhatsappText(to: string, body: string): Promise<boolean> {
  const text = body.length > MAX_TEXT ? body.slice(0, MAX_TEXT - 3) + '...' : body
  const token = env.get('WHATSAPP_TOKEN')?.release()
  const phoneId = env.get('WHATSAPP_PHONE_NUMBER_ID')
  if (!token || !phoneId) {
    logger.info({ to, text }, 'whatsapp not configured; reply not delivered')
    return false
  }
  const version = env.get('WHATSAPP_GRAPH_VERSION') ?? 'v21.0'
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text().catch(() => '') }, 'whatsapp send failed')
      return false
    }
    return true
  } catch (err) {
    logger.error({ err }, 'whatsapp send error')
    return false
  }
}
