import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'
import School from '#models/school'
import CalendarEvent from '#models/calendar_event'
import WebhookEndpoint from '#models/webhook_endpoint'
import WebhookDelivery from '#models/webhook_delivery'
import { EVENT_TYPES, emitEvent, newSecret } from '#services/events'
import { activeIntegration, decryptSecrets, encryptSecrets, providerCtx, publicApiBase } from '#services/integrations/store'
import { meetingFor } from '#services/integrations/extra_providers'
import { dispatch } from '#services/queue'
import DeliverWebhookJob from '#jobs/deliver_webhook_job'

const ALL_TYPES = EVENT_TYPES.map((e) => e.type as string)

const endpointValidator = vine.compile(
  vine.object({
    url: vine.string().trim().url({ require_protocol: true, protocols: ['https', 'http'] }).maxLength(500),
    description: vine.string().trim().maxLength(160).nullable().optional(),
    events: vine.array(vine.string()).minLength(1),
    active: vine.boolean().optional(),
  })
)

const meetingValidator = vine.compile(
  vine.object({
    time: vine.string().regex(/^\d{2}:\d{2}$/),
    durationMinutes: vine.number().min(10).max(600),
  })
)

/** Private network targets a webhook must never reach (SSRF guard). */
function isPrivateUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd')) return true
    return false
  } catch {
    return true
  }
}

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

export default class ConnectionsExtrasController {
  /* ---------------- outbound webhooks ---------------- */

  async eventTypes({ serialize }: HttpContext) {
    return serialize(EVENT_TYPES)
  }

  async endpoints({ school, serialize }: HttpContext) {
    const rows = await WebhookEndpoint.query().where('school_id', school.id).orderBy('id')
    const since = DateTime.now().minus({ days: 7 }).toSQL()!
    const stats = await WebhookDelivery.query()
      .where('school_id', school.id)
      .where('created_at', '>=', since)
      .select('endpoint_id', 'status')
    return serialize(
      rows.map((r) => {
        const mine = stats.filter((s) => s.endpointId === r.id)
        return {
          ...this.endpointJson(r),
          last7: { delivered: mine.filter((s) => s.status === 'delivered').length, failed: mine.filter((s) => s.status === 'failed').length },
        }
      })
    )
  }

  async storeEndpoint({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(endpointValidator)
    if (isPrivateUrl(p.url)) return response.unprocessableEntity({ message: 'Use a public URL. Private and local addresses are not allowed.' })
    const secret = newSecret()
    const row = await WebhookEndpoint.create({
      schoolId: school.id,
      url: p.url,
      description: p.description ?? null,
      secret: encryptSecrets({ secret }),
      events: p.events.includes('*') ? ['*'] : p.events.filter((e) => ALL_TYPES.includes(e)),
      active: p.active ?? true,
      createdByUserId: auth.user?.id ?? null,
    })
    response.status(201)
    // The signing secret is shown once, on creation.
    return serialize({ ...this.endpointJson(row), secret })
  }

  async updateEndpoint({ school, params, request, response, serialize }: HttpContext) {
    const row = await WebhookEndpoint.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Webhook not found' })
    const p = await request.validateUsing(endpointValidator)
    if (isPrivateUrl(p.url)) return response.unprocessableEntity({ message: 'Use a public URL. Private and local addresses are not allowed.' })
    row.merge({
      url: p.url,
      description: p.description ?? null,
      events: p.events.includes('*') ? ['*'] : p.events.filter((e) => ALL_TYPES.includes(e)),
      active: p.active ?? row.active,
    })
    await row.save()
    return serialize(this.endpointJson(row))
  }

  async rotateSecret({ school, params, response, serialize }: HttpContext) {
    const row = await WebhookEndpoint.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Webhook not found' })
    const secret = newSecret()
    row.secret = encryptSecrets({ secret })
    await row.save()
    return serialize({ ...this.endpointJson(row), secret })
  }

  async destroyEndpoint({ school, params, response }: HttpContext) {
    const row = await WebhookEndpoint.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Webhook not found' })
    await row.delete()
    return response.noContent()
  }

  async testEndpoint({ school, params, response, serialize }: HttpContext) {
    const row = await WebhookEndpoint.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Webhook not found' })
    await emitEvent(school.id, 'webhook.test', { message: `Test event from ${school.name}. If you see this, the webhook works.` }, row.id)
    return serialize({ queued: true })
  }

  async deliveries({ school, params, serialize }: HttpContext) {
    const rows = await WebhookDelivery.query()
      .where('school_id', school.id)
      .where('endpoint_id', Number(params.id))
      .orderBy('id', 'desc')
      .limit(50)
    return serialize(
      rows.map((d) => ({
        id: d.id,
        event: d.event,
        eventId: d.eventId,
        status: d.status,
        attempts: d.attempts,
        responseCode: d.responseCode,
        lastError: d.lastError,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
        payload: d.payload,
      }))
    )
  }

  async redeliver({ school, params, response, serialize }: HttpContext) {
    const d = await WebhookDelivery.query().where('school_id', school.id).where('id', params.id).first()
    if (!d) return response.notFound({ message: 'Delivery not found' })
    d.status = 'pending'
    await d.save()
    await dispatch(DeliverWebhookJob, { deliveryId: d.id }, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, jobId: `webhook-${d.id}-${Date.now()}` })
    return serialize({ queued: true })
  }

  /* ---------------- calendar feed (ICS) ---------------- */

  async feed({ school, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    let token = ((fresh.settings ?? {}) as any).calendarFeedToken as string | undefined
    if (!token) {
      token = randomBytes(18).toString('hex')
      fresh.settings = { ...(fresh.settings ?? {}), calendarFeedToken: token }
      await fresh.save()
    }
    return serialize({ url: `${publicApiBase()}/api/v1/calendar-feed/${token}.ics` })
  }

  async rotateFeed({ school, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    const token = randomBytes(18).toString('hex')
    fresh.settings = { ...(fresh.settings ?? {}), calendarFeedToken: token }
    await fresh.save()
    return serialize({ url: `${publicApiBase()}/api/v1/calendar-feed/${token}.ics` })
  }

  /** Public, read-only subscription feed. The token is the only key. */
  async ics({ params, response }: HttpContext) {
    const token = String(params.token ?? '').replace(/\.ics$/, '')
    if (!/^[a-f0-9]{36}$/.test(token)) return response.notFound('Not found')
    const school = await School.query().whereRaw("settings->>'calendarFeedToken' = ?", [token]).first()
    if (!school) return response.notFound('Not found')
    const events = await CalendarEvent.query().where('school_id', school.id).orderBy('starts_on')
    const stamp = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'")
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Schoolify//School calendar//EN',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${icsEscape(school.name)}`,
      'X-WR-TIMEZONE:Africa/Lagos',
    ]
    for (const e of events) {
      const start = e.startsOn
      const end = (e.endsOn ?? e.startsOn).plus({ days: 1 })
      lines.push(
        'BEGIN:VEVENT',
        `UID:schoolify-${school.id}-${e.id}@schoolify.twelveai.app`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${start.toFormat('yyyyLLdd')}`,
        `DTEND;VALUE=DATE:${end.toFormat('yyyyLLdd')}`,
        `SUMMARY:${icsEscape(e.title)}`
      )
      const desc = [e.description, e.meetingUrl ? `Join: ${e.meetingUrl}` : null].filter(Boolean).join('\n')
      if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`)
      if (e.meetingUrl) lines.push(`URL:${e.meetingUrl}`)
      lines.push('END:VEVENT')
    }
    lines.push('END:VCALENDAR')
    response.header('Content-Type', 'text/calendar; charset=utf-8')
    response.header('Cache-Control', 'public, max-age=900')
    return response.send(lines.join('\r\n') + '\r\n')
  }

  /* ---------------- online meetings ---------------- */

  async createMeeting({ school, params, request, response, serialize }: HttpContext) {
    const event = await CalendarEvent.query().where('school_id', school.id).where('id', params.id).first()
    if (!event) return response.notFound({ message: 'Event not found' })
    const p = await request.validateUsing(meetingValidator)
    const integ = await activeIntegration(school.id, 'meetings')
    const adapter = integ ? meetingFor(integ.provider) : undefined
    if (!integ || !adapter) return response.unprocessableEntity({ message: 'Connect Zoom in Settings, Connections first.' })
    const start = DateTime.fromISO(`${event.startsOn.toISODate()}T${p.time}`, { zone: 'Africa/Lagos' })
    try {
      const m = await adapter.createMeeting(providerCtx(integ, school), {
        topic: event.title,
        startIso: start.toISO({ suppressMilliseconds: true })!,
        durationMinutes: Math.round(p.durationMinutes),
        agenda: event.description,
      })
      event.merge({ meetingUrl: m.joinUrl, meetingProvider: integ.provider })
      await event.save()
      return serialize({ meetingUrl: m.joinUrl })
    } catch (e) {
      return response.badGateway({ message: (e as Error).message })
    }
  }

  async removeMeeting({ school, params, response, serialize }: HttpContext) {
    const event = await CalendarEvent.query().where('school_id', school.id).where('id', params.id).first()
    if (!event) return response.notFound({ message: 'Event not found' })
    event.merge({ meetingUrl: null, meetingProvider: null })
    await event.save()
    return serialize({ meetingUrl: null })
  }

  private endpointJson(r: WebhookEndpoint) {
    const secret = decryptSecrets(r.secret).secret ?? ''
    return {
      id: r.id,
      url: r.url,
      description: r.description,
      events: r.events,
      active: r.active,
      secretHint: secret ? `whsec_****${secret.slice(-4)}` : null,
      createdAt: r.createdAt,
    }
  }
}
