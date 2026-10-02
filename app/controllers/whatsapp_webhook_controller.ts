import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { dispatch } from '#services/queue'
import { verifyWhatsappSignature } from '#services/whatsapp'
import WhatsappInboundJob from '#jobs/whatsapp_inbound_job'

/**
 * Public Meta WhatsApp Cloud API webhook. GET = subscription handshake,
 * POST = inbound messages (HMAC-verified with the app secret). Work is
 * queued so Meta gets a fast 200 (or a 500 to retry if queueing failed); the job id is the WhatsApp
 * message id, so redeliveries are dropped by the queue.
 */
export default class WhatsappWebhookController {
  async verify({ request, response }: HttpContext) {
    const mode = request.input('hub.mode')
    const token = request.input('hub.verify_token')
    const challenge = request.input('hub.challenge')
    const expected = env.get('WHATSAPP_VERIFY_TOKEN')?.release()
    if (mode === 'subscribe' && expected && token === expected) {
      return response.status(200).send(String(challenge ?? ''))
    }
    return response.forbidden({ message: 'Verification failed' })
  }

  async receive({ request, response }: HttpContext) {
    const raw = request.raw() ?? ''
    if (!verifyWhatsappSignature(raw, request.header('x-hub-signature-256'))) {
      return response.unauthorized({ message: 'Invalid signature' })
    }
    const body = request.body() as any
    let queued = 0
    let failed = 0
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const m of change?.value?.messages ?? []) {
          if (!m?.from || !m?.id) continue
          const text = m.type === 'text' ? String(m.text?.body ?? '') : null
          try {
            await dispatch(
              WhatsappInboundJob,
              { from: String(m.from), text, messageId: String(m.id) },
              { jobId: `wa-${String(m.id).replace(/:/g, '_')}`, removeOnComplete: { age: 86400 }, attempts: 1 }
            )
            queued++
          } catch (err) {
            failed++
            logger.error({ err }, 'could not queue whatsapp message')
          }
        }
      }
    }
    // A non-200 makes Meta redeliver; already-queued messages are deduped by job id.
    if (failed > 0) return response.internalServerError({ ok: false, queued, failed })
    return response.ok({ ok: true, queued })
  }
}
