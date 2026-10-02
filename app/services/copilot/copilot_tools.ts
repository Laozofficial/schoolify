import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import Term from '#models/term'
import AttendanceRecord from '#models/attendance_record'
import FeeInvoice from '#models/fee_invoice'
import Exam from '#models/exam'
import ExamAttempt from '#models/exam_attempt'
import LeaveRequest from '#models/leave_request'
import StudentRiskFlag from '#models/student_risk_flag'
import AssignmentSubmission from '#models/assignment_submission'
import Assignment from '#models/assignment'
import type { AiTool } from '#services/ai'
import { computeClassResults } from '#services/class_results'
import { naira } from '#services/assistant/family_tools'

/**
 * Admin copilot tools. All are read-only, school-scoped aggregates, except
 * the two `propose_*` tools which only PREPARE an action card; nothing is
 * published or sent until an admin clicks the button in the UI.
 *
 * Privacy: parent contact details (phones, emails) are never returned to
 * the model; admins look those up in the portal.
 */

const TZ = 'Africa/Lagos'
const TERM_NAME: Record<string, string> = { first: 'First', second: 'Second', third: 'Third' }

export type CopilotAction =
  | { type: 'announcement'; title: string; body: string; audience: string }
  | {
      type: 'fee_reminder'
      message: string
      classIds: number[] | null
      minBalanceNaira: number | null
      onlyOverdue: boolean
      students: number
      totalOutstanding: string
    }

const nullableInt = (description: string) => ({ type: ['integer', 'null'], description })
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

export const COPILOT_TOOLS: AiTool[] = [
  {
    name: 'school_overview',
    description: 'Headline numbers: students per class, staff by role, current term.',
    parameters: obj({}),
  },
  {
    name: 'list_classes',
    description: 'All classes with id, name, class teacher and number of students. Use to resolve class names to ids.',
    parameters: obj({}),
  },
  {
    name: 'attendance_summary',
    description: 'Attendance rates per class over a period, plus the students with the lowest attendance.',
    parameters: obj({
      period: { type: 'string', enum: ['last_7_days', 'last_30_days', 'this_term'] },
      classId: nullableInt('Limit to one class, or null for the whole school.'),
    }),
  },
  {
    name: 'fees_summary',
    description:
      'Fees for a term: amount invoiced, collected, outstanding and collection rate, by class, plus the students owing the most.',
    parameters: obj({
      termId: nullableInt('A term id, or null for the current term.'),
      classId: nullableInt('Limit to one class, or null for the whole school.'),
    }),
  },
  {
    name: 'academic_summary',
    description: 'Term results: average per class, subject averages, and top and bottom students.',
    parameters: obj({
      termId: nullableInt('A term id, or null for the current term.'),
      classId: nullableInt('Limit to one class, or null for every class.'),
    }),
  },
  {
    name: 'find_students',
    description: 'Search students by name or admission number. Returns ids for student_snapshot.',
    parameters: obj({ query: { type: 'string' } }),
  },
  {
    name: 'student_snapshot',
    description: "One student's current picture: results, attendance, fees, missing work and early warning flags.",
    parameters: obj({ studentId: { type: 'integer' } }),
  },
  {
    name: 'early_warning_overview',
    description: 'Students on the early warning list with priority and reasons.',
    parameters: obj({ level: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] } }),
  },
  {
    name: 'exams_overview',
    description: 'CBT exams awaiting review, live exams, and exams with results not yet published.',
    parameters: obj({}),
  },
  {
    name: 'staff_overview',
    description: 'Staff on approved leave today and leave requests waiting for a decision.',
    parameters: obj({}),
  },
  {
    name: 'propose_announcement',
    description:
      'Prepare a draft announcement for the admin to review. It is NOT published; the admin sees a button to save it as a draft.',
    parameters: obj({
      title: { type: 'string' },
      body: { type: 'string' },
      audience: { type: 'string', enum: ['everyone', 'parents', 'students', 'staff', 'teachers'] },
    }),
  },
  {
    name: 'propose_fee_reminder',
    description:
      'Prepare an in-app fee reminder to the families of students with unpaid fees. It is NOT sent; the admin sees how many families it would reach and a button to send.',
    parameters: obj({
      message: { type: 'string', description: 'Short, polite reminder text. Each family also sees their own balance.' },
      classIds: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Limit to these classes, or null for all.' },
      minBalanceNaira: { type: ['number', 'null'], description: 'Only balances at or above this amount, or null.' },
      onlyOverdue: { type: 'boolean', description: 'Only invoices past their due date.' },
    }),
  },
]

function termLabel(t: Term) {
  return `${TERM_NAME[t.name] ?? t.name} term ${t.session}`
}
function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 1000) / 10 : null
}
function name(s: { firstName: string; lastName: string | null }) {
  return [s.firstName, s.lastName].filter(Boolean).join(' ')
}

/**
 * Students with an unpaid balance, with the filters used by fee reminders.
 * Shared by the propose tool (to preview) and the send endpoint (to act),
 * so what the admin previews is exactly what gets sent.
 */
export async function feeReminderTargets(
  schoolId: number,
  f: { classIds: number[] | null; minBalanceNaira: number | null; onlyOverdue: boolean }
) {
  const today = DateTime.now().setZone(TZ).toISODate()!
  const q = FeeInvoice.query()
    .where('school_id', schoolId)
    .whereNotIn('status', ['paid', 'cancelled'])
    .preload('payments')
    .preload('student')
  if (f.onlyOverdue) q.whereNotNull('due_on').where('due_on', '<', today)
  const invoices = await q
  const byStudent = new Map<number, { student: Student; balanceKobo: number }>()
  for (const inv of invoices) {
    if (!inv.student || inv.student.isArchived) continue
    if (f.classIds && f.classIds.length && !f.classIds.includes(inv.student.classId ?? -1)) continue
    const bal = Number(inv.totalAmountKobo) - inv.payments.reduce((t, p) => t + Number(p.amountKobo), 0)
    if (bal <= 0) continue
    const cur = byStudent.get(inv.studentId) ?? { student: inv.student, balanceKobo: 0 }
    cur.balanceKobo += bal
    byStudent.set(inv.studentId, cur)
  }
  const min = f.minBalanceNaira ? f.minBalanceNaira * 100 : 0
  return [...byStudent.values()].filter((x) => x.balanceKobo >= min)
}

export function copilotToolExecutor(schoolId: number, actions: CopilotAction[]) {
  async function resolveTerm(termId: unknown) {
    if (termId) return Term.query().where('id', Number(termId)).where('school_id', schoolId).first()
    return (
      (await Term.query().where('school_id', schoolId).where('is_current', true).first()) ??
      (await Term.query().where('school_id', schoolId).orderBy('starts_on', 'desc').first())
    )
  }
  async function classIdsFor(classId: unknown) {
    if (classId) {
      const c = await SchoolClass.query().where('id', Number(classId)).where('school_id', schoolId).first()
      if (!c) throw new Error('Class not found. Use list_classes to find the right id.')
      return [c]
    }
    return SchoolClass.query().where('school_id', schoolId).orderBy('name', 'asc')
  }

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
    async school_overview() {
      const [classes, term, staff] = await Promise.all([
        SchoolClass.query()
          .where('school_id', schoolId)
          .withCount('students', (q) => q.where('is_archived', false))
          .orderBy('name', 'asc'),
        resolveTerm(null),
        db
          .from('user_school_roles')
          .where('school_id', schoolId)
          .whereNotIn('role', ['parent', 'student'])
          .select('role')
          .count('* as total')
          .groupBy('role'),
      ])
      const perClass = classes.map((c) => ({ class: c.name, students: Number(c.$extras.students_count) }))
      return {
        currentTerm: term ? termLabel(term) : null,
        totalStudents: perClass.reduce((t, c) => t + c.students, 0),
        studentsPerClass: perClass,
        staffByRole: Object.fromEntries(staff.map((r: any) => [r.role, Number(r.total)])),
      }
    },

    async list_classes() {
      const classes = await SchoolClass.query()
        .where('school_id', schoolId)
        .preload('classTeacher')
        .withCount('students', (q) => q.where('is_archived', false))
        .orderBy('name', 'asc')
      return classes.map((c) => ({
        classId: c.id,
        name: c.name,
        classTeacher: c.classTeacher?.fullName ?? null,
        students: Number(c.$extras.students_count),
      }))
    },

    async attendance_summary(a) {
      const end = DateTime.now().setZone(TZ).startOf('day')
      let start = end.minus({ days: 6 })
      let label = 'last 7 days'
      if (a.period === 'last_30_days') {
        start = end.minus({ days: 29 })
        label = 'last 30 days'
      } else if (a.period === 'this_term') {
        const t = await resolveTerm(null)
        if (t?.startsOn) {
          start = t.startsOn.setZone(TZ).startOf('day')
          label = termLabel(t)
        }
      }
      const classes = await classIdsFor(a.classId)
      const classIds = classes.map((c) => c.id)
      const recs = await AttendanceRecord.query()
        .join('attendance_days', 'attendance_days.id', 'attendance_records.attendance_day_id')
        .whereIn('attendance_days.class_id', classIds.length ? classIds : [0])
        .whereBetween('attendance_days.date', [start.toISODate()!, end.toISODate()!])
        .select('attendance_records.student_id', 'attendance_records.status', 'attendance_days.class_id as cls')
      const byClass = new Map<number, { total: number; attended: number; absent: number }>()
      const byStudent = new Map<number, { total: number; attended: number }>()
      for (const r of recs) {
        const cid = Number(r.$extras.cls)
        const c = byClass.get(cid) ?? { total: 0, attended: 0, absent: 0 }
        const s = byStudent.get(r.studentId) ?? { total: 0, attended: 0 }
        c.total++
        s.total++
        if (r.status === 'present' || r.status === 'late') {
          c.attended++
          s.attended++
        }
        if (r.status === 'absent') c.absent++
        byClass.set(cid, c)
        byStudent.set(r.studentId, s)
      }
      const lowIds = [...byStudent.entries()]
        .filter(([, v]) => v.total >= 3)
        .sort((x, y) => x[1].attended / x[1].total - y[1].attended / y[1].total)
        .slice(0, 8)
      const lowStudents = lowIds.length
        ? await Student.query().whereIn('id', lowIds.map(([id]) => id)).preload('schoolClass')
        : []
      const sBy = new Map(lowStudents.map((s) => [s.id, s]))
      const totals = [...byClass.values()].reduce(
        (t, c) => ({ total: t.total + c.total, attended: t.attended + c.attended }),
        { total: 0, attended: 0 }
      )
      return {
        period: label,
        sessionsMarked: totals.total,
        schoolAttendancePercent: pct(totals.attended, totals.total),
        byClass: classes.map((c) => {
          const v = byClass.get(c.id)
          return {
            class: c.name,
            sessionsMarked: v?.total ?? 0,
            attendancePercent: v ? pct(v.attended, v.total) : null,
            absences: v?.absent ?? 0,
          }
        }),
        lowestAttendance: lowIds.map(([id, v]) => ({
          studentId: id,
          name: sBy.get(id) ? name(sBy.get(id)!) : null,
          class: sBy.get(id)?.schoolClass?.name ?? null,
          attendancePercent: pct(v.attended, v.total),
        })),
        note: totals.total === 0 ? 'No attendance has been marked in this period.' : null,
      }
    },

    async fees_summary(a) {
      const term = await resolveTerm(a.termId)
      const classes = await classIdsFor(a.classId)
      const classIds = new Set(classes.map((c) => c.id))
      const q = FeeInvoice.query()
        .where('school_id', schoolId)
        .whereNot('status', 'cancelled')
        .preload('payments')
        .preload('student')
      if (term) q.where('term_id', term.id)
      const invoices = (await q).filter((i) => i.student && classIds.has(i.student.classId ?? -1))
      const today = DateTime.now().setZone(TZ).startOf('day')
      let invoiced = 0
      let collected = 0
      let overdueKobo = 0
      const byClass = new Map<number, { invoiced: number; collected: number }>()
      const byStudent = new Map<number, { s: Student; bal: number; overdue: boolean }>()
      for (const inv of invoices) {
        const total = Number(inv.totalAmountKobo)
        const paid = inv.payments.reduce((t, p) => t + Number(p.amountKobo), 0)
        const bal = Math.max(0, total - paid)
        invoiced += total
        collected += paid
        const overdue = !!inv.dueOn && inv.dueOn < today && bal > 0
        if (overdue) overdueKobo += bal
        const cid = inv.student.classId!
        const c = byClass.get(cid) ?? { invoiced: 0, collected: 0 }
        c.invoiced += total
        c.collected += paid
        byClass.set(cid, c)
        if (bal > 0) {
          const cur = byStudent.get(inv.studentId) ?? { s: inv.student, bal: 0, overdue: false }
          cur.bal += bal
          cur.overdue ||= overdue
          byStudent.set(inv.studentId, cur)
        }
      }
      const top = [...byStudent.values()].sort((x, y) => y.bal - x.bal).slice(0, 15)
      const className = new Map(classes.map((c) => [c.id, c.name]))
      return {
        term: term ? termLabel(term) : 'all terms',
        invoiced: naira(invoiced),
        collected: naira(collected),
        outstanding: naira(invoiced - collected),
        overdue: naira(overdueKobo),
        collectionRatePercent: pct(collected, invoiced),
        studentsOwing: byStudent.size,
        byClass: [...byClass.entries()].map(([cid, v]) => ({
          class: className.get(cid) ?? null,
          invoiced: naira(v.invoiced),
          collected: naira(v.collected),
          outstanding: naira(v.invoiced - v.collected),
          collectionRatePercent: pct(v.collected, v.invoiced),
        })),
        topBalances: top.map((x) => ({
          studentId: x.s.id,
          name: name(x.s),
          class: className.get(x.s.classId ?? -1) ?? null,
          balance: naira(x.bal),
          overdue: x.overdue,
        })),
      }
    },

    async academic_summary(a) {
      const term = await resolveTerm(a.termId)
      if (!term) return { note: 'No term has been set up.' }
      const classes = await classIdsFor(a.classId)
      const subjectTotals = new Map<string, { sum: number; n: number }>()
      const perClass = []
      for (const c of classes) {
        const r = await computeClassResults(schoolId, c.id, term.id)
        const rows = (r?.rows ?? []).filter((x) => x.overall.percentage !== null)
        for (const row of rows) {
          for (const s of row.subjects) {
            if (s.percentage === null) continue
            const t = subjectTotals.get(s.subjectName) ?? { sum: 0, n: 0 }
            t.sum += s.percentage
            t.n++
            subjectTotals.set(s.subjectName, t)
          }
        }
        const sorted = [...rows].sort((x, y) => y.overall.percentage! - x.overall.percentage!)
        perClass.push({
          class: c.name,
          studentsWithResults: rows.length,
          averagePercent: rows.length
            ? Math.round((rows.reduce((t, x) => t + x.overall.percentage!, 0) / rows.length) * 10) / 10
            : null,
          top: sorted.slice(0, 3).map((x) => ({ name: x.student.fullName, percent: x.overall.percentage })),
          bottom: sorted.length > 3 ? sorted.slice(-3).reverse().map((x) => ({ name: x.student.fullName, percent: x.overall.percentage })) : [],
        })
      }
      return {
        term: termLabel(term),
        byClass: perClass,
        subjectAverages: [...subjectTotals.entries()]
          .map(([subject, t]) => ({ subject, averagePercent: Math.round((t.sum / t.n) * 10) / 10 }))
          .sort((x, y) => x.averagePercent - y.averagePercent),
      }
    },

    async find_students(a) {
      const q = String(a.query ?? '').trim()
      if (q.length < 2) return { error: 'Search needs at least 2 characters.' }
      const like = `%${q.toLowerCase()}%`
      const rows = await Student.query()
        .where('school_id', schoolId)
        .where('is_archived', false)
        .where((w) =>
          w
            .whereRaw('lower(first_name) like ?', [like])
            .orWhereRaw('lower(last_name) like ?', [like])
            .orWhereRaw("lower(first_name || ' ' || last_name) like ?", [like])
            .orWhereRaw('lower(admission_number) like ?', [like])
        )
        .preload('schoolClass')
        .limit(10)
      return rows.map((s) => ({ studentId: s.id, name: name(s), admissionNumber: s.admissionNumber, class: s.schoolClass?.name ?? null }))
    },

    async student_snapshot(a) {
      const s = await Student.query()
        .where('id', Number(a.studentId))
        .where('school_id', schoolId)
        .preload('schoolClass')
        .first()
      if (!s) return { error: 'Student not found.' }
      const term = await resolveTerm(null)
      let results = null
      if (term && s.classId) {
        const r = await computeClassResults(schoolId, s.classId, term.id)
        const row = r?.rows.find((x) => x.student.id === s.id)
        if (row) {
          results = {
            term: termLabel(term),
            averagePercent: row.overall.percentage,
            grade: row.overall.grade,
            position: row.overall.position ? `${row.overall.position} of ${row.overall.classSize}` : null,
            weakestSubjects: row.subjects
              .filter((x) => x.percentage !== null)
              .sort((x, y) => x.percentage! - y.percentage!)
              .slice(0, 3)
              .map((x) => `${x.subjectName} ${Math.round(x.percentage!)}%`),
          }
        }
      }
      const since = DateTime.now().setZone(TZ).minus({ days: 29 }).toISODate()!
      const att = await AttendanceRecord.query()
        .where('attendance_records.student_id', s.id)
        .join('attendance_days', 'attendance_days.id', 'attendance_records.attendance_day_id')
        .where('attendance_days.date', '>=', since)
        .select('attendance_records.status')
      const attended = att.filter((r) => r.status === 'present' || r.status === 'late').length
      const fees = await feeReminderTargets(schoolId, { classIds: null, minBalanceNaira: null, onlyOverdue: false })
      const owed = fees.find((x) => x.student.id === s.id)
      const flag = await StudentRiskFlag.query().where('student_id', s.id).first()
      const due = s.classId
        ? await Assignment.query()
            .where('class_id', s.classId)
            .where('published', true)
            .where('deadline', '<', DateTime.now().toSQL()!)
            .where('deadline', '>=', DateTime.now().minus({ days: 30 }).toSQL()!)
        : []
      const subs = due.length
        ? await AssignmentSubmission.query().where('student_id', s.id).whereIn('assignment_id', due.map((d) => d.id))
        : []
      return {
        studentId: s.id,
        name: name(s),
        admissionNumber: s.admissionNumber,
        class: s.schoolClass?.name ?? null,
        results,
        attendanceLast30Days: att.length ? { sessions: att.length, percent: pct(attended, att.length) } : null,
        feesOutstanding: owed ? naira(owed.balanceKobo) : naira(0),
        assignmentsMissedLast30Days: due.length - subs.length,
        earlyWarning: flag
          ? { level: flag.level, status: flag.status, reasons: flag.signals.map((x) => `${x.label}: ${x.detail}`) }
          : null,
      }
    },

    async early_warning_overview(a) {
      const q = StudentRiskFlag.query()
        .where('school_id', schoolId)
        .where('status', 'open')
        .preload('student')
        .preload('schoolClass')
        .orderBy('score', 'desc')
        .limit(25)
      if (a.level) q.where('level', String(a.level))
      const flags = await q
      return flags.map((f) => ({
        studentId: f.studentId,
        name: f.student ? name(f.student) : null,
        class: f.schoolClass?.name ?? null,
        level: f.level,
        reasons: f.signals.map((x) => x.label),
        suggestedAction: f.suggestedAction,
      }))
    },

    async exams_overview() {
      const exams = await Exam.query()
        .where('school_id', schoolId)
        .preload('schoolClass')
        .preload('subject')
        .preload('teacher')
        .withCount('attempts', (q) => q.where('status', 'submitted'))
      const label = (e: Exam) => `${e.title} (${e.schoolClass?.name ?? '?'}, ${e.teacher?.fullName ?? 'unknown teacher'})`
      const awaiting = exams.filter((e) => e.status === 'submitted')
      const live = exams.filter((e) => e.status === 'approved')
      const unpublished = live.filter((e) => !e.resultsApprovedAt && Number(e.$extras.attempts_count) > 0)
      return {
        awaitingReview: awaiting.map(label),
        liveCount: live.length,
        resultsNotPublished: unpublished.map((e) => ({ exam: label(e), submissions: Number(e.$extras.attempts_count) })),
        sentBackToTeachers: exams.filter((e) => e.status === 'rejected').length,
        drafts: exams.filter((e) => e.status === 'draft').length,
      }
    },

    async staff_overview() {
      const today = DateTime.now().setZone(TZ).toISODate()!
      const [onLeave, pending] = await Promise.all([
        LeaveRequest.query()
          .where('school_id', schoolId)
          .where('status', 'approved')
          .where('starts_on', '<=', today)
          .where('ends_on', '>=', today)
          .preload('user'),
        LeaveRequest.query().where('school_id', schoolId).where('status', 'pending').preload('user'),
      ])
      const fmt = (l: LeaveRequest) => ({
        staff: l.user?.fullName ?? null,
        kind: l.kind,
        from: l.startsOn.toFormat('d LLL yyyy'),
        to: l.endsOn.toFormat('d LLL yyyy'),
      })
      return { onLeaveToday: onLeave.map(fmt), pendingRequests: pending.map(fmt) }
    },

    async propose_announcement(a) {
      const title = String(a.title ?? '').trim().slice(0, 200)
      const body = String(a.body ?? '').trim().slice(0, 5000)
      if (!title || !body) return { error: 'Title and body are required.' }
      actions.push({ type: 'announcement', title, body, audience: String(a.audience ?? 'everyone') })
      return { prepared: true, note: 'Draft shown to the admin. Nothing has been published.' }
    },

    async propose_fee_reminder(a) {
      const filters = {
        classIds: Array.isArray(a.classIds) && a.classIds.length ? a.classIds.map(Number) : null,
        minBalanceNaira: a.minBalanceNaira ? Number(a.minBalanceNaira) : null,
        onlyOverdue: a.onlyOverdue === true,
      }
      const targets = await feeReminderTargets(schoolId, filters)
      const total = targets.reduce((t, x) => t + x.balanceKobo, 0)
      const message = String(a.message ?? '').trim().slice(0, 1000)
      if (!message) return { error: 'A reminder message is required.' }
      if (targets.length === 0) return { prepared: false, students: 0, note: 'No students match these filters.' }
      actions.push({
        type: 'fee_reminder',
        message,
        ...filters,
        students: targets.length,
        totalOutstanding: naira(total),
      })
      return {
        prepared: true,
        students: targets.length,
        totalOutstanding: naira(total),
        note: 'Shown to the admin with a Send button. Nothing has been sent.',
      }
    },
  }

  return async (toolName: string, args: Record<string, unknown>) => {
    const h = handlers[toolName]
    if (!h) return { error: `Unknown tool ${toolName}` }
    return h(args)
  }
}
