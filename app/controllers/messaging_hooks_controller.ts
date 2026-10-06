import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import Integration from '#models/integration'
import MessageDelivery from '#models/message_delivery'
import { providerFor } from '#services/integrations/providers'

/**
 * Public delivery-report endpoint. Each connection gets its own unguessable
 * URL (`hook_token`), which is how we know which school and provider sent
 * the report. Always answers 200 quickly so providers do not retry forever.
 */
export default class MessagingHooksController {
  /** Meta webhook verification handshake (hub.verify_token == hook token). */
  async verify({ params, request, response }: HttpContext) {
    const qs = request.qs()
    if (qs['hub.mode'] === 'subscribe' && qs['hub.verify_token'] === params.token) {
      const row = await Integration.findBy('hook_token', params.token)
      if (row) return response.ok(String(qs['hub.challenge'] ?? ''))
    }
    return response.forbidden('forbidden')
  }

  async receive({ params, request, response }: HttpContext) {
    const row = await Integration.findBy('hook_token', String(params.token))
    if (!row) return response.ok({ ok: true })
    const adapter = providerFor(row.provider)
    if (!adapter?.parseWebhook) return response.ok({ ok: true })

    let updates: ReturnType<NonNullable<typeof adapter.parseWebhook>> = []
    try {
      updates = adapter.parseWebhook(request.body(), request.headers() as Record<string, string | undefined>)
    } catch (e) {
      logger.warn({ err: e, provider: row.provider }, 'could not parse delivery report')
    }

    for (const u of updates) {
      const d = await MessageDelivery.query()
        .where('school_id', row.schoolId)
        .where('integration_id', row.id)
        .where('provider_message_id', u.providerMessageId)
        .first()
      if (!d || d.status === 'delivered') continue
      if (u.status === 'delivered') {
        d.status = 'delivered'
        d.deliveredAt = DateTime.now()
        d.error = null
      } else if (u.status === 'failed') {
        d.status = 'failed'
        d.error = u.error ?? 'Delivery failed'
      }
      await d.save()
    }
    return response.ok({ ok: true })
  }
}
