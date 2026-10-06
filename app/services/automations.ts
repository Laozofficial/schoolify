import logger from '@adonisjs/core/services/logger'
import School from '#models/school'
import Student from '#models/student'
import { createCampaign, type Channel } from '#services/messaging'

/**
 * Automatic alerts to parents. Each event has a default message the school
 * can edit and a set of channels it can be sent on. All events start OFF so
 * nobody is charged for SMS they did not ask for.
 */

export interface AutomationEvent {
  key: string
  label: string
  description: string
  subject: string
  body: string
  /** Channels this event may use. In-app is excluded where the app already notifies. */
  channels: Channel[]
  tokens: string[]
}

export const AUTOMATION_EVENTS: AutomationEvent[] = [
  {
    key: 'absence',
    label: 'Absence and late arrival',
    description: 'When a student is marked absent, late or sick in a class register.',
    subject: 'Attendance update: {{student_name}}',
    body: 'Dear {{first_name}}, {{student_name}} was marked {{status}} today ({{date}}) in {{class_name}}. Please contact the school if this is unexpected. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email', 'in_app'],
    tokens: ['status', 'date'],
  },
  {
    key: 'invoice',
    label: 'New fee invoice',
    description: 'When an invoice is issued to a student.',
    subject: 'New invoice for {{student_name}}',
    body: 'Dear {{first_name}}, invoice {{invoice_number}} of {{amount}} has been issued for {{student_name}}.{{due}} You can pay in the parent portal. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email'],
    tokens: ['invoice_number', 'amount', 'due'],
  },
  {
    key: 'payment',
    label: 'Payment received',
    description: 'When a fee payment is recorded, online or by hand.',
    subject: 'Payment received for {{student_name}}',
    body: 'Dear {{first_name}}, we have received {{amount}} for {{student_name}} ({{invoice_number}}). {{balance_line}} Thank you. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email'],
    tokens: ['amount', 'invoice_number', 'balance_line'],
  },
  {
    key: 'installment',
    label: 'Instalment reminder',
    description: 'Three days before an instalment is due, and the day after it is missed.',
    subject: 'Fee instalment for {{student_name}}',
    body: 'Dear {{first_name}}, {{label}} of {{amount}} for {{student_name}} is {{when}}. You can pay in the parent portal. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email', 'in_app'],
    tokens: ['label', 'amount', 'when', 'due_date'],
  },
  {
    key: 'results',
    label: 'Exam results published',
    description: 'When a CBT exam result is released to families.',
    subject: '{{exam_title}} results',
    body: 'Dear {{first_name}}, results for {{exam_title}} are now available for {{student_name}} in the parent portal. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email'],
    tokens: ['exam_title'],
  },
  {
    key: 'pickup',
    label: 'Child collected',
    description: 'When the gate releases a child to a guardian.',
    subject: '{{student_name}} has been collected',
    body: 'Dear {{first_name}}, {{student_name}} was collected from school at {{time}} by {{collector}}. {{school_name}}',
    channels: ['sms', 'whatsapp', 'email', 'in_app'],
    tokens: ['time', 'collector'],
  },
  {
    key: 'gate_arrival',
    label: 'Arrived at school',
    description: 'When a student is scanned in at the gate.',
    subject: '{{student_name}} arrived at school',
    body: 'Dear {{first_name}}, {{student_name}} arrived at school at {{time}}. {{school_name}}',
    channels: ['sms', 'whatsapp', 'in_app'],
    tokens: ['time'],
  },
  {
    key: 'gate_departure',
    label: 'Left school',
    description: 'When a student is scanned out at the gate.',
    subject: '{{student_name}} left school',
    body: 'Dear {{first_name}}, {{student_name}} left school at {{time}}. {{school_name}}',
    channels: ['sms', 'whatsapp', 'in_app'],
    tokens: ['time'],
  },
]

export interface AutomationSetting {
  enabled: boolean
  channels: Channel[]
  subject?: string | null
  body?: string | null
}

export function automationSettings(school: School): Record<string, AutomationSetting> {
  const raw = ((school.settings ?? {}) as any).automations ?? {}
  const out: Record<string, AutomationSetting> = {}
  for (const ev of AUTOMATION_EVENTS) {
    const s = raw[ev.key] ?? {}
    out[ev.key] = {
      enabled: !!s.enabled,
      channels: (Array.isArray(s.channels) ? s.channels : []).filter((c: Channel) => ev.channels.includes(c)),
      subject: s.subject ?? null,
      body: s.body ?? null,
    }
  }
  return out
}

/**
 * Fire an event for one student's guardians. Never throws: an alert must not
 * break the action that triggered it (marking a register, recording a payment).
 */
export async function fireAutomation(
  schoolId: number,
  key: string,
  opts: { studentId: number; vars?: Record<string, string>; dedupeKey?: string }
) {
  try {
    const ev = AUTOMATION_EVENTS.find((e) => e.key === key)
    if (!ev) return
    const school = await School.find(schoolId)
    if (!school) return
    const setting = automationSettings(school)[key]
    if (!setting?.enabled || setting.channels.length === 0) return
    const student = await Student.find(opts.studentId)
    if (!student) return
    const name = `${student.firstName} ${student.lastName}`.trim()
    await createCampaign({
      schoolId,
      title: `${ev.label}: ${name}`,
      channels: setting.channels,
      audience: { type: 'parents_of_students', studentIds: [student.id], dedupeKey: opts.dedupeKey },
      subject: setting.subject || ev.subject,
      body: setting.body || ev.body,
      source: 'automation',
      event: key,
      vars: { student_name: name, ...(opts.vars ?? {}) },
    })
  } catch (e) {
    logger.error({ err: e, schoolId, key }, 'automation failed')
  }
}
