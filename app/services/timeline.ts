import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * One chronological history per person, assembled from every module
 * (attendance, gate, pickup, fees, exams, early warning, messages, leave,
 * payroll). Read-only; each source caps its own rows so a busy year stays
 * fast.
 */

export interface TimelineEvent {
  at: string
  kind: string
  tone: 'brand' | 'emerald' | 'amber' | 'red' | 'slate'
  title: string
  detail: string | null
}

const naira = (k: unknown) => '₦' + (Number(k ?? 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })
const iso = (v: any) => (v instanceof Date ? v.toISOString() : DateTime.fromJSDate(new Date(v)).toISO()!)
const LIMIT = 60

export async function studentTimeline(schoolId: number, studentId: number): Promise<TimelineEvent[]> {
  const out: TimelineEvent[] = []

  const student = await db.from('students').where('school_id', schoolId).where('id', studentId).select('created_at', 'admission_year').first()
  if (!student) return []
  out.push({ at: iso(student.created_at), kind: 'enrolled', tone: 'brand', title: 'Added to the school', detail: student.admission_year ? `Admitted ${student.admission_year}` : null })

  const absences = await db
    .from('attendance_records as r')
    .join('attendance_days as d', 'd.id', 'r.attendance_day_id')
    .where('d.school_id', schoolId)
    .where('r.student_id', studentId)
    .whereNot('r.status', 'present')
    .orderBy('d.date', 'desc')
    .limit(LIMIT)
    .select('r.status', 'r.remark', 'd.date', 'd.session')
  for (const a of absences) {
    out.push({
      at: iso(a.date),
      kind: 'attendance',
      tone: a.status === 'absent' ? 'red' : 'amber',
      title: `Marked ${a.status} (${a.session})`,
      detail: a.remark,
    })
  }

  const gate = await db
    .from('gate_events')
    .where('school_id', schoolId)
    .where('student_id', studentId)
    .orderBy('occurred_at', 'desc')
    .limit(LIMIT)
    .select('direction', 'late', 'method', 'occurred_at')
  for (const g of gate) {
    out.push({
      at: iso(g.occurred_at),
      kind: 'gate',
      tone: g.late ? 'amber' : 'slate',
      title: g.direction === 'in' ? (g.late ? 'Arrived late' : 'Arrived at school') : 'Left school',
      detail: g.method === 'qr' ? 'Card scan' : g.method === 'manual' ? 'Signed in by staff' : null,
    })
  }

  const pickups = await db
    .from('pickup_logs')
    .where('school_id', schoolId)
    .where('student_id', studentId)
    .orderBy('occurred_at', 'desc')
    .limit(LIMIT)
    .select('outcome', 'collector_name', 'occurred_at')
  for (const p of pickups) {
    out.push({
      at: iso(p.occurred_at),
      kind: 'pickup',
      tone: p.outcome === 'released' ? 'emerald' : 'red',
      title: p.outcome === 'released' ? 'Collected from school' : 'Pickup refused (wrong code)',
      detail: p.collector_name ? `By ${p.collector_name}` : null,
    })
  }

  const invoices = await db
    .from('fee_invoices')
    .where('school_id', schoolId)
    .where('student_id', studentId)
    .orderBy('issued_on', 'desc')
    .limit(20)
    .select('invoice_number', 'total_amount_kobo', 'issued_on', 'created_at', 'status')
  for (const i of invoices) {
    out.push({
      at: iso(i.issued_on ?? i.created_at),
      kind: 'invoice',
      tone: 'slate',
      title: `Invoice ${i.invoice_number} issued`,
      detail: `${naira(i.total_amount_kobo)} · now ${i.status}`,
    })
  }

  const payments = await db
    .from('payments as p')
    .join('fee_invoices as i', 'i.id', 'p.invoice_id')
    .where('p.school_id', schoolId)
    .where('p.student_id', studentId)
    .orderBy('p.paid_at', 'desc')
    .limit(30)
    .select('p.amount_kobo', 'p.method', 'p.paid_at', 'i.invoice_number')
  for (const p of payments) {
    out.push({ at: iso(p.paid_at), kind: 'payment', tone: 'emerald', title: `Paid ${naira(p.amount_kobo)}`, detail: `${p.invoice_number} · ${p.method}` })
  }

  const exams = await db
    .from('exam_attempts as a')
    .join('exams as e', 'e.id', 'a.exam_id')
    .where('a.student_id', studentId)
    .where('e.school_id', schoolId)
    .whereNotNull('a.submitted_at')
    .orderBy('a.submitted_at', 'desc')
    .limit(30)
    .select('e.title', 'a.score', 'a.total_marks', 'a.submitted_at')
  for (const x of exams) {
    const pct = x.total_marks ? Math.round((Number(x.score) / Number(x.total_marks)) * 100) : null
    out.push({
      at: iso(x.submitted_at),
      kind: 'exam',
      tone: pct == null ? 'slate' : pct >= 50 ? 'brand' : 'amber',
      title: `Sat ${x.title}`,
      detail: x.total_marks ? `${x.score}/${x.total_marks} (${pct}%)` : null,
    })
  }

  const reports = await db
    .from('report_approvals as r')
    .join('terms as t', 't.id', 'r.term_id')
    .where('r.student_id', studentId)
    .where('t.school_id', schoolId)
    .select('r.approved_at', 't.name', 't.session')
  for (const r of reports) {
    out.push({ at: iso(r.approved_at), kind: 'report', tone: 'brand', title: `${String(r.name).charAt(0).toUpperCase() + String(r.name).slice(1)} term report card released`, detail: r.session })
  }

  const flags = await db
    .from('student_risk_flags')
    .where('school_id', schoolId)
    .where('student_id', studentId)
    .orderBy('computed_at', 'desc')
    .limit(10)
    .select('level', 'summary', 'status', 'computed_at')
  for (const f of flags) {
    out.push({
      at: iso(f.computed_at),
      kind: 'risk',
      tone: f.level === 'high' ? 'red' : f.level === 'medium' ? 'amber' : 'slate',
      title: `Early warning: ${f.level} concern`,
      detail: [f.summary, f.status !== 'open' ? `(${f.status})` : null].filter(Boolean).join(' '),
    })
  }

  const messages = await db
    .from('message_deliveries as d')
    .join('message_campaigns as c', 'c.id', 'd.campaign_id')
    .where('d.school_id', schoolId)
    .where('d.student_id', studentId)
    .whereIn('d.status', ['sent', 'delivered'])
    .groupBy('c.id', 'c.title', 'c.created_at')
    .orderBy('c.created_at', 'desc')
    .limit(30)
    .select('c.title', 'c.created_at', db.raw("string_agg(distinct d.channel, ', ') as channels"))
  for (const m of messages) {
    out.push({ at: iso(m.created_at), kind: 'message', tone: 'slate', title: `Guardians messaged: ${m.title}`, detail: String(m.channels).replace('in_app', 'in-app') })
  }

  return out.sort((a, b) => b.at.localeCompare(a.at))
}

export async function staffTimeline(schoolId: number, userId: number): Promise<TimelineEvent[]> {
  const out: TimelineEvent[] = []

  const roles = await db.from('user_school_roles').where('school_id', schoolId).where('user_id', userId).select('role', 'created_at')
  for (const r of roles) {
    out.push({ at: iso(r.created_at), kind: 'role', tone: 'brand', title: `Joined as ${String(r.role).replace(/_/g, ' ')}`, detail: null })
  }

  const gate = await db
    .from('gate_events')
    .where('school_id', schoolId)
    .where('user_id', userId)
    .orderBy('occurred_at', 'desc')
    .limit(LIMIT)
    .select('direction', 'late', 'method', 'occurred_at', 'distance_m')
  for (const g of gate) {
    out.push({
      at: iso(g.occurred_at),
      kind: 'gate',
      tone: g.late ? 'amber' : 'slate',
      title: g.direction === 'in' ? (g.late ? 'Checked in late' : 'Checked in') : 'Checked out',
      detail: g.method === 'gps' ? `Phone check-in${g.distance_m != null ? `, ${g.distance_m} m from school` : ''}` : g.method === 'qr' ? 'Card scan' : 'Recorded at the gate',
    })
  }

  const leave = await db
    .from('leave_requests')
    .where('school_id', schoolId)
    .where('user_id', userId)
    .orderBy('created_at', 'desc')
    .limit(30)
    .select('kind', 'status', 'starts_on', 'ends_on', 'created_at')
  for (const l of leave) {
    out.push({
      at: iso(l.created_at),
      kind: 'leave',
      tone: l.status === 'approved' ? 'emerald' : l.status === 'denied' ? 'red' : 'amber',
      title: `${String(l.kind).charAt(0).toUpperCase() + String(l.kind).slice(1)} leave ${l.status}`,
      detail: `${DateTime.fromJSDate(new Date(l.starts_on)).toFormat('d LLL')} to ${DateTime.fromJSDate(new Date(l.ends_on)).toFormat('d LLL yyyy')}`,
    })
  }

  const slips = await db
    .from('payslips as s')
    .join('payroll_runs as r', 'r.id', 's.run_id')
    .where('s.school_id', schoolId)
    .where('s.user_id', userId)
    .whereIn('r.status', ['approved', 'paid'])
    .orderBy('r.period', 'desc')
    .limit(24)
    .select('r.period', 'r.status', 'r.approved_at', 'r.paid_at', 's.net_kobo')
  for (const s of slips) {
    out.push({
      at: iso(s.paid_at ?? s.approved_at),
      kind: 'payroll',
      tone: 'emerald',
      title: `${DateTime.fromFormat(s.period, 'yyyy-MM').toFormat('LLLL yyyy')} salary ${s.status === 'paid' ? 'paid' : 'approved'}`,
      detail: `Net ${naira(s.net_kobo)}`,
    })
  }

  const exams = await db.from('exams').where('school_id', schoolId).where('teacher_id', userId).orderBy('created_at', 'desc').limit(20).select('title', 'status', 'created_at')
  for (const e of exams) {
    out.push({ at: iso(e.created_at), kind: 'exam', tone: 'brand', title: `Set exam: ${e.title}`, detail: String(e.status) })
  }

  return out.sort((a, b) => b.at.localeCompare(a.at))
}
