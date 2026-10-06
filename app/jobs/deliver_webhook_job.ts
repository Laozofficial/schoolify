import { DateTime } from 'luxon'
import { BaseJob, type JobPayload } from '#jobs/base_job'
import WebhookDelivery from '#models/webhook_delivery'
import WebhookEndpoint from '#models/webhook_endpoint'
import { decryptSecrets } from '#services/integrations/store'
import { signature } from '#services/events'

export interface DeliverWebhookPayload extends JobPayload {
  deliveryId: number
}

/**
 * POST one event to one endpoint. Any non-2xx or network error throws so
 * BullMQ retries with exponential backoff (6 attempts over about 30
 * minutes); the row keeps the latest status and error for the admin.
 */
export default class DeliverWebhookJob extends BaseJob<DeliverWebhookPayload> {
  static queueName = 'default'
  static jobName = 'deliver_webhook'

  async handle({ deliveryId }: DeliverWebhookPayload) {
    const d = await WebhookDelivery.find(deliveryId)
    if (!d || d.status === 'delivered') return
    const endpoint = await WebhookEndpoint.find(d.endpointId)
    if (!endpoint || !endpoint.active) return

    const secret = decryptSecrets(endpoint.secret).secret ?? ''
    const body = JSON.stringify(d.payload)
    d.attempts += 1
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Schoolify-Webhooks/1.0',
          'X-Schoolify-Event': d.event,
          'X-Schoolify-Delivery': String(d.id),
          'X-Schoolify-Signature': signature(secret, body),
        },
        body,
        signal: ctrl.signal,
      })
      d.responseCode = res.status
      if (res.status >= 200 && res.status < 300) {
        d.status = 'delivered'
        d.deliveredAt = DateTime.now()
        d.lastError = null
        await d.save()
        return
      }
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`)
    } catch (e) {
      d.status = 'failed'
      d.lastError = (e as Error).name === 'AbortError' ? 'Timed out after 10 seconds' : String((e as Error).message).slice(0, 500)
      await d.save()
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
