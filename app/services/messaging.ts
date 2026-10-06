import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import mail from '@adonisjs/mail/services/main'
import env from '#start/env'
import School from '#models/school'
import MessageCampaign from '#models/message_campaign'
import MessageDelivery from '#models/message_delivery'
import Notification from '#models/notification'
import type Integration from '#models/integration'
import { activeIntegration, providerCtx } from '#services/integrations/store'
import { providerFor, textToHtml, type Kind } from '#services/integrations/providers'

/**
 * Messaging centre: audience resolution, per-recipient rendering, and the
 * send loop the worker runs. Every message becomes one `message_deliveries`
 * row per recipient per channel so the school can see exactly who got what.
 */

export type Channel = 'sms' | 'email' | 'whatsapp' | 'in_app'
export const CHANNELS: Channel[] = ['sms', 'email', 'whatsapp', 'in_app']

export type Audience =
  | { type: 'all_parents' }
  | { type: 'parents_of_classes'; classIds: number[] }
  | { type: 'parents_of_students'; studentIds: number[] }
  | { type: 'all_staff' }
  | { type: 'staff_roles'; roles: string[] }
  | { type: 'students_of_classes'; classIds: number[] }
  | { type: 'users'; userIds: number[] }

export interface Recipient {
  userId: number | null
  studentId: number | null
  name: string | null
  phone: string | null
  email: string | null
  vars: Record<string, string>
}

const STAFF_ROLES = ['super_admin', 'admin', 'teacher', 'accountant', 'non_academic_staff']

function firstName(name: string | null | undefined) {
  return (name ?? '').trim().split(/\s+/)[0] || 'there'
}

function joinNames(names: string[]) {
  const u = [...new Set(names.filter(Boolean))]
  if (u.length <= 1) return u[0] ?? ''
  return u.slice(0, -1).join(', ') + ' and ' + u[u.length - 1]
}

/** Synthetic student logins end in .local and must never be emailed. */
function realEmail(e: string | null | undefined): string | null {
  if (!e || !e.includes('@') || e.endsWith('.local')) return null
  return e
}

/** Expand an audience into concrete recipients with personalisation vars. */
export async function resolveAudience(schoolId: number, audience: Audience): Promise<Recipient[]> {
  if (audience.type === 'all_parents' || audience.type === 'parents_of_classes' || audience.type === 'parents_of_students') {
    const q = db
      .from('parent_students as ps')
      .join('students as s', 's.id', 'ps.student_id')
      .join('users as u', 'u.id', 'ps.parent_user_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .where('s.school_id', schoolId)
      .where('s.is_archived', false)
      .select(
        'u.id as user_id',
        'u.full_name',
        'u.email',
        'u.phone',
        's.id as student_id',
        's.first_name',
        's.last_name',
        'c.name as class_name'
      )
    if (audience.type === 'parents_of_classes') q.whereIn('s.class_id', audience.classIds.length ? audience.classIds : [-1])
    if (audience.type === 'parents_of_students') q.whereIn('s.id', audience.studentIds.length ? audience.studentIds : [-1])
    const rows = await q
    const byParent = new Map<number, { row: any; kids: string[]; classes: string[]; studentIds: number[] }>()
    for (const r of rows) {
      const cur = byParent.get(r.user_id) ?? { row: r, kids: [], classes: [], studentIds: [] }
      cur.kids.push(`${r.first_name} ${r.last_name}`.trim())
      if (r.class_name) cur.classes.push(r.class_name)
      cur.studentIds.push(r.student_id)
      byParent.set(r.user_id, cur)
    }
    return [...byParent.values()].map(({ row, kids, classes, studentIds }) => ({
      userId: row.user_id,
      studentId: studentIds.length === 1 ? studentIds[0] : null,
      name: row.full_name,
      phone: row.phone,
      email: realEmail(row.email),
      vars: {
        recipient_name: row.full_name ?? '',
        first_name: firstName(row.full_name),
        student_name: joinNames(kids),
        class_name: joinNames(classes),
      },
    }))
  }

  if (audience.type === 'all_staff' || audience.type === 'staff_roles' || audience.type === 'users') {
    const q = db
      .from('users as u')
      .join('user_school_roles as r', 'r.user_id', 'u.id')
      .where('r.school_id', schoolId)
      .distinct('u.id', 'u.full_name', 'u.email', 'u.phone')
    if (audience.type === 'all_staff') q.whereIn('r.role', STAFF_ROLES)
    if (audience.type === 'staff_roles') q.whereIn('r.role', audience.roles.filter((r) => STAFF_ROLES.includes(r)).concat(['__none']))
    if (audience.type === 'users') q.whereIn('u.id', audience.userIds.length ? audience.userIds : [-1])
    const rows = await q
    return rows.map((r: any) => ({
      userId: r.id,
      studentId: null,
      name: r.full_name,
      phone: r.phone,
      email: realEmail(r.email),
      vars: { recipient_name: r.full_name ?? '', first_name: firstName(r.full_name), student_name: '', class_name: '' },
    }))
  }

  // students_of_classes
  const rows = await db
    .from('students as s')
    .leftJoin('users as u', 'u.id', 's.user_id')
    .leftJoin('classes as c', 'c.id', 's.class_id')
    .where('s.school_id', schoolId)
    .where('s.is_archived', false)
    .whereIn('s.class_id', audience.classIds.length ? audience.classIds : [-1])
    .select('s.id', 's.first_name', 's.last_name', 's.phone', 's.email', 's.user_id', 'u.email as login_email', 'c.name as class_name')
  return rows.map((r: any) => {
    const name = `${r.first_name} ${r.last_name}`.trim()
    return {
      userId: r.user_id,
      studentId: r.id,
      name,
      phone: r.phone,
      email: realEmail(r.email) ?? realEmail(r.login_email),
      vars: { recipient_name: name, first_name: r.first_name, student_name: name, class_name: r.class_name ?? '' },
    }
  })
}

/** Replace {{tokens}}. Unknown tokens render empty rather than leaking braces. */
export function render(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export const TOKENS: { token: string; label: string }[] = [
  { token: 'first_name', label: "Recipient's first name" },
  { token: 'recipient_name', label: "Recipient's full name" },
  { token: 'student_name', label: 'Child or student name' },
  { token: 'class_name', label: 'Class' },
  { token: 'school_name', label: 'School name' },
]

export interface CreateCampaignInput {
  schoolId: number
  title: string
  channels: Channel[]
  audience: Audience & { dedupeKey?: string }
  subject?: string | null
  body: string
  source?: 'manual' | 'automation'
  event?: string | null
  createdByUserId?: number | null
  /** Extra vars merged into every recipient (event details). */
  vars?: Record<string, string>
}

/**
 * Create a campaign, expand it into delivery rows (in-app ones are written
 * immediately) and queue the worker to send the rest. Returns null when an
 * automation with the same dedupe key already ran.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<MessageCampaign | null> {
  const school = await School.findOrFail(input.schoolId)
  const dedupeKey = input.audience.dedupeKey
  if (dedupeKey) {
    const exists = await MessageCampaign.query()
      .where('school_id', input.schoolId)
      .whereRaw("audience->>'dedupeKey' = ?", [dedupeKey])
      .first()
    if (exists) return null
  }

  const recipients = await resolveAudience(input.schoolId, input.audience)
  // An automatic alert with nobody to tell (no linked guardian) is not worth a record.
  if (recipients.length === 0 && input.source === 'automation') return null
  const channels = [...new Set(input.channels)].filter((c) => CHANNELS.includes(c))

  const integrations: Partial<Record<Kind, Integration | null>> = {}
  for (const c of channels) {
    if (c !== 'in_app') integrations[c] = await activeIntegration(input.schoolId, c)
  }

  const campaign = await MessageCampaign.create({
    schoolId: input.schoolId,
    title: input.title.slice(0, 200),
    channels,
    audience: input.audience as unknown as Record<string, unknown>,
    subject: input.subject ?? null,
    body: input.body,
    source: input.source ?? 'manual',
    event: input.event ?? null,
    status: 'queued',
    total: 0,
    createdByUserId: input.createdByUserId ?? null,
  })

  const now = new Date()
  const rows: Partial<MessageDelivery>[] = []
  for (const r of recipients) {
    const vars = { school_name: school.name, ...r.vars, ...(input.vars ?? {}) }
    const body = render(input.body, vars)
    const subject = input.subject ? render(input.subject, vars) : null
    for (const channel of channels) {
      const base = {
        schoolId: input.schoolId,
        campaignId: campaign.id,
        channel,
        recipientUserId: r.userId,
        studentId: r.studentId,
        recipientName: r.name,
        subject,
        body,
      }
      if (channel === 'in_app') {
        if (!r.userId) continue
        await Notification.create({
          userId: r.userId,
          schoolId: input.schoolId,
          kind: input.event ? `msg_${input.event}` : 'message',
          title: subject || input.title,
          body,
          data: { kind: 'message', campaignId: campaign.id },
        })
        rows.push({ ...base, toAddress: null, provider: 'in_app', status: 'delivered', deliveredAt: now as any })
        continue
      }
      const address = channel === 'email' ? r.email : r.phone
      const integ = integrations[channel]
      if (!address) {
        rows.push({ ...base, toAddress: null, status: 'skipped', error: channel === 'email' ? 'No email address' : 'No phone number' })
      } else if (!integ && channel !== 'email') {
        rows.push({ ...base, toAddress: address, status: 'skipped', error: `No ${channel === 'sms' ? 'SMS' : 'WhatsApp'} connection set up` })
      } else {
        rows.push({
          ...base,
          toAddress: address,
          integrationId: integ?.id ?? null,
          provider: integ?.provider ?? 'platform',
          status: 'queued',
        })
      }
    }
  }

  if (rows.length) {
    await db.table('message_deliveries').multiInsert(
      rows.map((r) => ({
        school_id: r.schoolId,
        campaign_id: r.campaignId,
        channel: r.channel,
        integration_id: r.integrationId ?? null,
        provider: r.provider ?? null,
        recipient_user_id: r.recipientUserId ?? null,
        student_id: r.studentId ?? null,
        recipient_name: r.recipientName ?? null,
        to_address: r.toAddress ?? null,
        subject: r.subject ?? null,
        body: r.body,
        status: r.status,
        error: r.error ?? null,
        delivered_at: r.deliveredAt ?? null,
        created_at: now,
        updated_at: now,
      }))
    )
  }
  campaign.total = rows.length
  campaign.status = rows.some((r) => r.status === 'queued') ? 'queued' : 'done'
  await campaign.save()

  if (campaign.status === 'queued') {
    const { dispatch } = await import('#services/queue')
    const { default: SendCampaignJob } = await import('#jobs/send_campaign_job')
    await dispatch(SendCampaignJob, { campaignId: campaign.id }, { jobId: `campaign-${campaign.id}-${Date.now()}` })
  }
  return campaign
}

/** Send one queued delivery. Never throws: failures are recorded on the row. */
export async function sendDelivery(row: MessageDelivery, school: School, integrations: Map<number, Integration>) {
  try {
    let providerMessageId: string | null = null
    if (row.provider === 'platform') {
      const from = env.get('MAIL_FROM_ADDRESS')
      await mail.send((m) => {
        m.from(from, school.name)
          .to(row.toAddress!)
          .subject(row.subject || school.name)
          .html(textToHtml(row.body, school.name))
          .text(row.body)
      })
    } else {
      const integ = row.integrationId ? integrations.get(row.integrationId) : undefined
      const adapter = integ ? providerFor(integ.provider) : undefined
      if (!integ || !adapter) throw new Error('The connection for this channel was removed')
      const res = await adapter.send(providerCtx(integ, school), {
        to: row.toAddress!,
        subject: row.subject,
        body: row.body,
      })
      providerMessageId = res.providerMessageId
    }
    row.status = 'sent'
    row.providerMessageId = providerMessageId
    row.error = null
    row.sentAt = new Date() as any
  } catch (e) {
    row.status = 'failed'
    row.error = String((e as Error).message ?? e).slice(0, 500)
    logger.warn({ deliveryId: row.id, err: row.error }, 'message delivery failed')
  }
  await row.save()
}

/** Status counts for a set of campaigns. */
export async function campaignStats(campaignIds: number[]) {
  const out = new Map<number, Record<string, number>>()
  if (!campaignIds.length) return out
  const rows = await db
    .from('message_deliveries')
    .whereIn('campaign_id', campaignIds)
    .groupBy('campaign_id', 'status')
    .select('campaign_id', 'status')
    .count('* as n')
  for (const r of rows as any[]) {
    const cur = out.get(r.campaign_id) ?? {}
    cur[r.status] = Number(r.n)
    out.set(r.campaign_id, cur)
  }
  return out
}
