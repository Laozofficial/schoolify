import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import MessageCampaign from '#models/message_campaign'
import MessageDelivery from '#models/message_delivery'
import MessageTemplate from '#models/message_template'
import School from '#models/school'
import { dispatch } from '#services/queue'
import SendCampaignJob from '#jobs/send_campaign_job'
import { activeIntegration } from '#services/integrations/store'
import { providerFor } from '#services/integrations/providers'
import {
  campaignStats,
  createCampaign,
  resolveAudience,
  TOKENS,
  type Audience,
  type Channel,
} from '#services/messaging'
import { AUTOMATION_EVENTS, automationSettings } from '#services/automations'
import {
  audiencePreviewValidator,
  automationsValidator,
  sendCampaignValidator,
  templateValidator,
} from '#validators/messaging'

function toAudience(a: any): Audience {
  switch (a.type) {
    case 'parents_of_classes':
    case 'students_of_classes':
      return { type: a.type, classIds: a.classIds ?? [] }
    case 'parents_of_students':
      return { type: a.type, studentIds: a.studentIds ?? [] }
    case 'staff_roles':
      return { type: a.type, roles: a.roles ?? [] }
    case 'users':
      return { type: a.type, userIds: a.userIds ?? [] }
    default:
      return { type: a.type }
  }
}

export default class MessagingController {
  /** Which channels can send right now, plus 30-day delivery totals. */
  async overview({ school, serialize }: HttpContext) {
    const channels: Record<string, { ready: boolean; provider: string | null; note: string }> = {}
    for (const kind of ['sms', 'email', 'whatsapp'] as const) {
      const integ = await activeIntegration(school.id, kind)
      channels[kind] = integ
        ? { ready: integ.status !== 'error', provider: providerFor(integ.provider)?.def.name ?? integ.provider, note: integ.status === 'error' ? integ.lastError ?? 'Connection error' : 'Connected' }
        : kind === 'email'
          ? { ready: true, provider: 'Schoolify mail', note: 'Using the built-in sender. Connect your own for your domain.' }
          : { ready: false, provider: null, note: 'Not connected' }
    }
    channels.in_app = { ready: true, provider: 'Schoolify', note: 'Shows in the bell and the portal' }

    const since = new Date(Date.now() - 30 * 86400000)
    const totals = await db
      .from('message_deliveries')
      .where('school_id', school.id)
      .where('created_at', '>=', since)
      .groupBy('channel', 'status')
      .select('channel', 'status')
      .count('* as n')
    return serialize({
      channels,
      last30: (totals as any[]).map((t) => ({ channel: t.channel, status: t.status, count: Number(t.n) })),
      tokens: TOKENS,
    })
  }

  async audiencePreview({ school, request, serialize }: HttpContext) {
    const { audience } = await request.validateUsing(audiencePreviewValidator)
    const recipients = await resolveAudience(school.id, toAudience(audience))
    return serialize({
      total: recipients.length,
      withPhone: recipients.filter((r) => r.phone).length,
      withEmail: recipients.filter((r) => r.email).length,
      withLogin: recipients.filter((r) => r.userId).length,
      sample: recipients.slice(0, 6).map((r) => ({ name: r.name, studentName: r.vars.student_name || null })),
    })
  }

  async send({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(sendCampaignValidator)
    const campaign = await createCampaign({
      schoolId: school.id,
      title: payload.title,
      channels: payload.channels as Channel[],
      audience: toAudience(payload.audience),
      subject: payload.subject ?? null,
      body: payload.body,
      source: 'manual',
      createdByUserId: auth.user?.id ?? null,
    })
    if (!campaign) return response.conflict({ message: 'Already sent' })
    response.status(201)
    return serialize(await this.campaignJson(campaign))
  }

  async campaigns({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = MessageCampaign.query().where('school_id', school.id).preload('createdBy').orderBy('id', 'desc')
    if (qs.source === 'manual' || qs.source === 'automation') q.where('source', qs.source)
    const rows = await q.limit(Math.min(Number(qs.limit ?? 50), 200))
    const stats = await campaignStats(rows.map((r) => r.id))
    return serialize(rows.map((r) => this.campaignRow(r, stats.get(r.id) ?? {})))
  }

  async campaign({ school, params, response, serialize }: HttpContext) {
    const row = await MessageCampaign.query().where('school_id', school.id).where('id', params.id).preload('createdBy').first()
    if (!row) return response.notFound({ message: 'Message not found' })
    return serialize(await this.campaignJson(row))
  }

  /** Re-queue failed deliveries of a campaign. */
  async retry({ school, params, response, serialize }: HttpContext) {
    const row = await MessageCampaign.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Message not found' })
    const n = await MessageDelivery.query()
      .where('campaign_id', row.id)
      .where('status', 'failed')
      .update({ status: 'queued', error: null })
    const count = Array.isArray(n) ? Number(n[0]) : Number(n)
    if (count > 0) {
      row.status = 'queued'
      await row.save()
      await dispatch(SendCampaignJob, { campaignId: row.id }, { jobId: `campaign-${row.id}-${Date.now()}` })
    }
    return serialize({ requeued: count })
  }

  async deliveries({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = MessageDelivery.query().where('school_id', school.id).orderBy('id', 'desc')
    if (qs.status) q.where('status', String(qs.status))
    if (qs.channel) q.where('channel', String(qs.channel))
    if (qs.campaignId) q.where('campaign_id', Number(qs.campaignId))
    if (qs.q) q.where((w) => w.whereILike('recipient_name', `%${qs.q}%`).orWhereILike('to_address', `%${qs.q}%`))
    const rows = await q.limit(Math.min(Number(qs.limit ?? 100), 500))
    return serialize(rows.map((d) => this.deliveryRow(d)))
  }

  /* ---------------- templates ---------------- */

  async templates({ school, serialize }: HttpContext) {
    const rows = await MessageTemplate.query().where('school_id', school.id).orderBy('name')
    return serialize(rows)
  }

  async storeTemplate({ school, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(templateValidator)
    const row = await MessageTemplate.create({
      schoolId: school.id,
      name: p.name,
      channel: p.channel ?? 'any',
      subject: p.subject ?? null,
      body: p.body,
    })
    response.status(201)
    return serialize(row)
  }

  async updateTemplate({ school, params, request, response, serialize }: HttpContext) {
    const row = await MessageTemplate.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Template not found' })
    const p = await request.validateUsing(templateValidator)
    row.merge({ name: p.name, channel: p.channel ?? row.channel, subject: p.subject ?? null, body: p.body })
    await row.save()
    return serialize(row)
  }

  async destroyTemplate({ school, params, response }: HttpContext) {
    const row = await MessageTemplate.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Template not found' })
    await row.delete()
    return response.noContent()
  }

  /* ---------------- automations ---------------- */

  async automations({ school, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    return serialize({ events: AUTOMATION_EVENTS, settings: automationSettings(fresh) })
  }

  async saveAutomations({ school, request, serialize }: HttpContext) {
    const { automations } = await request.validateUsing(automationsValidator)
    const fresh = await School.findOrFail(school.id)
    const clean: Record<string, unknown> = {}
    for (const ev of AUTOMATION_EVENTS) {
      const s = automations[ev.key]
      if (!s) continue
      clean[ev.key] = {
        enabled: s.enabled,
        channels: s.channels.filter((c) => (ev.channels as string[]).includes(c)),
        subject: s.subject?.trim() || null,
        body: s.body?.trim() || null,
      }
    }
    fresh.settings = { ...(fresh.settings ?? {}), automations: clean }
    await fresh.save()
    return serialize({ events: AUTOMATION_EVENTS, settings: automationSettings(fresh) })
  }

  /* ---------------- helpers ---------------- */

  private async campaignJson(row: MessageCampaign) {
    const stats = (await campaignStats([row.id])).get(row.id) ?? {}
    const deliveries = await MessageDelivery.query().where('campaign_id', row.id).orderBy('id').limit(1000)
    if (!row.$preloaded.createdBy && row.createdByUserId) await row.load('createdBy')
    return { ...this.campaignRow(row, stats), body: row.body, deliveries: deliveries.map((d) => this.deliveryRow(d)) }
  }

  private campaignRow(row: MessageCampaign, stats: Record<string, number>) {
    return {
      id: row.id,
      title: row.title,
      channels: row.channels,
      audience: row.audience,
      subject: row.subject,
      preview: row.body.slice(0, 160),
      source: row.source,
      event: row.event,
      status: row.status,
      total: row.total,
      stats: {
        queued: stats.queued ?? 0,
        sent: stats.sent ?? 0,
        delivered: stats.delivered ?? 0,
        failed: stats.failed ?? 0,
        skipped: stats.skipped ?? 0,
      },
      createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
      createdAt: row.createdAt,
    }
  }

  private deliveryRow(d: MessageDelivery) {
    return {
      id: d.id,
      campaignId: d.campaignId,
      channel: d.channel,
      provider: d.provider,
      recipientName: d.recipientName,
      toAddress: d.toAddress,
      subject: d.subject,
      body: d.body,
      status: d.status,
      error: d.error,
      sentAt: d.sentAt,
      deliveredAt: d.deliveredAt,
      createdAt: d.createdAt,
    }
  }
}
