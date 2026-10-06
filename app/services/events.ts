import { createHmac, randomBytes } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import WebhookEndpoint from '#models/webhook_endpoint'
import WebhookDelivery from '#models/webhook_delivery'

/**
 * Outbound events. Anything interesting that happens at a school is emitted
 * here once; every active webhook endpoint subscribed to it gets a signed
 * POST from the worker, with retries. This is what lets a school connect
 * Zapier, Make, n8n, Google Sheets or its own systems without custom code.
 */

export const EVENT_TYPES = [
  { type: 'student.created', label: 'Student added', group: 'People' },
  { type: 'payment.received', label: 'Fee payment received', group: 'Finance' },
  { type: 'invoice.created', label: 'Invoice issued', group: 'Finance' },
  { type: 'income.recorded', label: 'Other income recorded', group: 'Finance' },
  { type: 'payroll.approved', label: 'Payroll approved', group: 'Finance' },
  { type: 'attendance.absent', label: 'Student marked absent or late', group: 'Attendance' },
  { type: 'gate.in', label: 'Arrived through the gate', group: 'Attendance' },
  { type: 'gate.out', label: 'Left through the gate', group: 'Attendance' },
  { type: 'pickup.released', label: 'Child collected', group: 'Attendance' },
  { type: 'exam.results_published', label: 'Exam results published', group: 'Academics' },
] as const

export type EventType = (typeof EVENT_TYPES)[number]['type'] | 'webhook.test'

export function newSecret(): string {
  return 'whsec_' + randomBytes(24).toString('hex')
}

/** Header value: t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">. */
export function signature(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return `t=${ts},v1=${v1}`
}

/**
 * Queue an event for every subscribed endpoint. Never throws: an outbound
 * integration must not break the action that triggered it.
 */
export async function emitEvent(schoolId: number, type: EventType, data: Record<string, unknown>, onlyEndpointId?: number) {
  try {
    const q = WebhookEndpoint.query().where('school_id', schoolId).where('active', true)
    if (onlyEndpointId) q.where('id', onlyEndpointId)
    const endpoints = (await q).filter((e) => onlyEndpointId || e.events.includes('*') || e.events.includes(type))
    if (!endpoints.length) return
    const eventId = 'evt_' + randomBytes(10).toString('hex')
    const payload = { id: eventId, type, createdAt: new Date().toISOString(), schoolId, data }
    const { dispatch } = await import('#services/queue')
    const { default: DeliverWebhookJob } = await import('#jobs/deliver_webhook_job')
    for (const e of endpoints) {
      const d = await WebhookDelivery.create({
        schoolId,
        endpointId: e.id,
        eventId,
        event: type,
        payload,
        status: 'pending',
        attempts: 0,
      })
      await dispatch(
        DeliverWebhookJob,
        { deliveryId: d.id },
        { attempts: 6, backoff: { type: 'exponential', delay: 30_000 }, jobId: `webhook-${d.id}` }
      )
    }
  } catch (e) {
    logger.error({ err: e, schoolId, type }, 'emitEvent failed')
  }
}
