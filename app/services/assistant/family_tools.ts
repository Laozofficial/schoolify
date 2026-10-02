import { DateTime } from 'luxon'
import type User from '#models/user'
import type Student from '#models/student'
import Term from '#models/term'
import ReportApproval from '#models/report_approval'
import ReportCardComment from '#models/report_card_comment'
import AttendanceRecord from '#models/attendance_record'
import TimetableSlot from '#models/timetable_slot'
import TimetableSlotException from '#models/timetable_slot_exception'
import Subject from '#models/subject'
import UserModel from '#models/user'
import FeeInvoice from '#models/fee_invoice'
import Assignment from '#models/assignment'
import AssignmentSubmission from '#models/assignment_submission'
import Exam from '#models/exam'
import ExamAttempt from '#models/exam_attempt'
import CalendarEvent from '#models/calendar_event'
import Announcement from '#models/announcement'
import type { Role } from '#models/user_school_role'
import type { AiTool } from '#services/ai'
import type { FamilyAccess } from '#services/family_access'
import { computeClassResults } from '#services/class_results'
import { pickupCodeFor } from '#services/pickup_code'
import { isPaymentConfigured } from '#services/payment_gateway'
import {
  buildCallerContext,
  callerMatchesAnyRule,
  type TargetRule,
} from '#services/announcement_targeting'

/**
 * Read-only tools for the family assistant. Every tool re-checks that the
 * requested student belongs to the caller, so a manipulated tool call can
 * never read another family's data. Money and dates are pre-formatted so
 * the model never has to do arithmetic.
 */

const TZ = 'Africa/Lagos'
const TERM_NAME: Record<string, string> = { first: 'First', second: 'Second', third: 'Third' }

export function naira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function termLabel(t: Term) {
  return `${TERM_NAME[t.name] ?? t.name} term ${t.session}`
}
function fmtDate(d: DateTime | null | undefined) {
  return d ? d.setZone(TZ).toFormat('cccc d LLLL yyyy') : null
}
function fullName(s: Student) {
  return [s.firstName, s.lastName].filter(Boolean).join(' ')
}

const studentIdParam = {
  studentId: { type: 'integer', description: 'The student id from the children list.' },
}

export const FAMILY_TOOLS: AiTool[] = [
  {
    name: 'list_children',
    description: 'List the students this user can ask about, with their class.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'get_report_card',
    description:
      'Term results for a student: overall average, grade, class position, per-subject scores and the teacher and principal remarks. Only released (approved) report cards are available.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId', 'termId'],
      properties: {
        ...studentIdParam,
        termId: {
          type: ['integer', 'null'],
          description: 'A specific term id, or null for the current term.',
        },
      },
    },
  },
  {
    name: 'get_attendance',
    description: 'Attendance summary and the days a student was absent or late.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId', 'period'],
      properties: {
        ...studentIdParam,
        period: { type: 'string', enum: ['last_7_days', 'last_30_days', 'this_term'] },
      },
    },
  },
  {
    name: 'get_timetable',
    description:
      "A student's class timetable for one school day, including today's changes, cancellations and holidays.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId', 'day'],
      properties: {
        ...studentIdParam,
        day: {
          type: 'string',
          enum: ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
      },
    },
  },
  {
    name: 'get_fees',
    description:
      'School fee invoices: totals, amount paid, balance, due dates and how to pay. Pass studentId null to get every child at once with an exact family total (use that instead of adding numbers yourself).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId'],
      properties: {
        studentId: {
          type: ['integer', 'null'],
          description: 'The student id from the children list, or null for all children.',
        },
      },
    },
  },
  {
    name: 'get_assignments',
    description: 'Homework and assignments for a student with deadlines and submission or grading status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId', 'filter'],
      properties: {
        ...studentIdParam,
        filter: { type: 'string', enum: ['due_soon', 'overdue', 'recent_all'] },
      },
    },
  },
  {
    name: 'get_exam_results',
    description:
      'CBT (computer based test) results that the school has published, plus exams currently open for the student to take.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId'],
      properties: { ...studentIdParam },
    },
  },
  {
    name: 'get_announcements',
    description: 'Recent school announcements visible to this user.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'get_school_calendar',
    description: 'School calendar events: term dates, resumption, holidays, mid-term break, PTA meetings, exams, sports.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['range'],
      properties: { range: { type: 'string', enum: ['next_30_days', 'next_90_days', 'this_term'] } },
    },
  },
  {
    name: 'get_pickup_code',
    description: "Today's child pickup code (parents only). It changes every day.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['studentId'],
      properties: { ...studentIdParam },
    },
  },
]

export function familyToolExecutor(user: User, schoolId: number, access: FamilyAccess) {
  const byId = new Map(access.students.map((s) => [s.id, s]))

  function need(studentId: unknown): Student {
    const s = byId.get(Number(studentId))
    if (!s) throw new Error('That student is not linked to this account. Only ask about the children listed.')
    return s
  }

  async function currentTerm(): Promise<Term | null> {
    return (
      (await Term.query().where('school_id', schoolId).where('is_current', true).first()) ??
      (await Term.query().where('school_id', schoolId).orderBy('starts_on', 'desc').first())
    )
  }

  const today = () => DateTime.now().setZone(TZ).startOf('day')

  function howToPay() {
    return isPaymentConfigured()
      ? 'Open My Portal, choose the Fees tab and tap Pay now on the invoice.'
      : 'Online payment is not enabled yet. Pay at the school office or by bank transfer as advised by the school.'
  }

  async function feesFor(s: Student) {
    const invoices = await FeeInvoice.query()
      .where('school_id', schoolId)
      .where('student_id', s.id)
      .preload('term')
      .preload('payments')
      .orderBy('issued_on', 'desc')
    let outstanding = 0
    const rows = invoices.map((inv) => {
      const total = Number(inv.totalAmountKobo)
      const paid = inv.payments.reduce((sum, p) => sum + Number(p.amountKobo), 0)
      const bal = Math.max(0, total - paid)
      if (inv.status !== 'paid' && inv.status !== 'cancelled') outstanding += bal
      return {
        invoice: inv.invoiceNumber,
        term: inv.term ? termLabel(inv.term) : null,
        total: naira(total),
        paid: naira(paid),
        balance: naira(bal),
        status: inv.status,
        dueOn: fmtDate(inv.dueOn),
        overdue: !!inv.dueOn && inv.dueOn < today() && bal > 0,
      }
    })
    return {
      outstandingKobo: outstanding,
      result: { student: fullName(s), totalOutstanding: naira(outstanding), invoices: rows },
    }
  }

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
    async list_children() {
      return access.students.map((s) => ({
        studentId: s.id,
        name: fullName(s),
        class: s.schoolClass?.name ?? null,
        relationship: access.wardIds.has(s.id) ? 'child' : 'self',
      }))
    },

    async get_report_card(a) {
      const s = need(a.studentId)
      const term = a.termId
        ? await Term.query().where('id', Number(a.termId)).where('school_id', schoolId).first()
        : await currentTerm()
      if (!term) return { available: false, message: 'No term has been set up yet.' }

      const released = await ReportApproval.query().where('student_id', s.id)
      const releasedTermIds = new Set(released.map((r) => r.termId))
      const releasedTerms = released.length
        ? await Term.query().whereIn('id', [...releasedTermIds]).orderBy('starts_on', 'desc')
        : []
      const otherReleasedTerms = releasedTerms
        .filter((t) => t.id !== term.id)
        .map((t) => ({ termId: t.id, term: termLabel(t) }))

      if (!releasedTermIds.has(term.id)) {
        return {
          available: false,
          student: fullName(s),
          term: termLabel(term),
          message: `The ${termLabel(term)} report card has not been released by the school yet.`,
          otherReleasedTerms,
        }
      }
      if (!s.classId) return { available: false, message: 'The student is not assigned to a class.' }

      const results = await computeClassResults(schoolId, s.classId, term.id)
      const row = results?.rows.find((r) => r.student.id === s.id)
      if (!row) return { available: false, message: 'No results were found for this term.' }
      const comment = await ReportCardComment.query()
        .where('term_id', term.id)
        .where('student_id', s.id)
        .first()

      return {
        available: true,
        student: fullName(s),
        class: results?.className,
        term: termLabel(term),
        overall: {
          averagePercent: row.overall.percentage,
          grade: row.overall.grade,
          remark: row.overall.remark,
          position: row.overall.position ? `${row.overall.position} of ${row.overall.classSize}` : null,
        },
        subjects: row.subjects
          .filter((x) => x.percentage !== null)
          .map((x) => ({ subject: x.subjectName, percent: x.percentage, grade: x.grade, position: x.position })),
        classTeacherRemark: comment?.classTeacherComment ?? null,
        principalRemark: comment?.principalComment ?? null,
        otherReleasedTerms,
      }
    },

    async get_attendance(a) {
      const s = need(a.studentId)
      const end = today()
      let start = end.minus({ days: 6 })
      let label = 'the last 7 days'
      if (a.period === 'last_30_days') {
        start = end.minus({ days: 29 })
        label = 'the last 30 days'
      } else if (a.period === 'this_term') {
        const t = await currentTerm()
        if (t?.startsOn) {
          start = t.startsOn.setZone(TZ).startOf('day')
          label = `this term (${termLabel(t)})`
        }
      }
      const recs = await AttendanceRecord.query()
        .where('attendance_records.student_id', s.id)
        .join('attendance_days', 'attendance_days.id', 'attendance_records.attendance_day_id')
        .whereBetween('attendance_days.date', [start.toISODate()!, end.toISODate()!])
        .select(
          'attendance_records.status',
          'attendance_records.remark',
          'attendance_days.date as day_date',
          'attendance_days.session as day_session'
        )
        .orderBy('attendance_days.date', 'desc')
      const counts: Record<string, number> = { present: 0, late: 0, absent: 0, excused: 0, sick: 0 }
      for (const r of recs) counts[r.status] = (counts[r.status] ?? 0) + 1
      const total = recs.length
      const notable = recs
        .filter((r) => r.status !== 'present')
        .slice(0, 15)
        .map((r) => ({
          date: fmtDate(DateTime.fromJSDate(new Date(r.$extras.day_date))),
          session: r.$extras.day_session,
          status: r.status,
          remark: r.remark,
        }))
      return {
        student: fullName(s),
        period: label,
        sessionsMarked: total,
        ...counts,
        attendanceRatePercent: total ? Math.round(((counts.present + counts.late) / total) * 100) : null,
        absencesAndLateness: notable,
      }
    },

    async get_timetable(a) {
      const s = need(a.studentId)
      if (!s.classId) return { message: 'The student is not assigned to a class.' }
      const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      let date = today()
      if (a.day === 'tomorrow') date = date.plus({ days: 1 })
      else if (a.day !== 'today') {
        const target = names.indexOf(String(a.day)) + 1
        while (date.weekday !== target) date = date.plus({ days: 1 })
      }
      if (date.weekday > 5) return { date: fmtDate(date), schoolDay: false, message: 'There is no school at the weekend.' }

      const events = await CalendarEvent.query()
        .where('school_id', schoolId)
        .where('starts_on', '<=', date.toISODate()!)
        .where((q) => q.where('ends_on', '>=', date.toISODate()!).orWhere((q2) => q2.whereNull('ends_on').where('starts_on', date.toISODate()!)))
      const holiday = events.find((e) =>
        ['holiday', 'public_holiday', 'break', 'mid_term_break', 'term_end'].includes(e.eventType)
      )

      const slots = await TimetableSlot.query()
        .where('school_id', schoolId)
        .where('class_id', s.classId)
        .where('day_of_week', date.weekday)
        .preload('period')
        .preload('subject')
        .preload('teacher')
      const exceptions = slots.length
        ? await TimetableSlotException.query()
            .whereIn('slot_id', slots.map((x) => x.id))
            .where('date', date.toISODate()!)
        : []
      const exBySlot = new Map(exceptions.map((e) => [e.slotId, e]))
      const subjectIds = exceptions.map((e) => e.subjectId).filter((x): x is number => !!x)
      const teacherIds = exceptions.map((e) => e.teacherId).filter((x): x is number => !!x)
      const [subs, teachers] = await Promise.all([
        subjectIds.length ? Subject.query().whereIn('id', subjectIds) : Promise.resolve([]),
        teacherIds.length ? UserModel.query().whereIn('id', teacherIds) : Promise.resolve([]),
      ])
      const subName = new Map(subs.map((x) => [x.id, x.name]))
      const teacherName = new Map(teachers.map((x) => [x.id, x.fullName]))

      const periods = slots
        .sort((x, y) => (x.period?.startTime ?? '').localeCompare(y.period?.startTime ?? ''))
        .map((slot) => {
          const ex = exBySlot.get(slot.id)
          return {
            time: `${slot.period?.startTime ?? ''}-${slot.period?.endTime ?? ''}`,
            period: slot.period?.name ?? null,
            subject: ex?.subjectId ? subName.get(ex.subjectId) : (slot.subject?.name ?? null),
            teacher: ex?.teacherId ? teacherName.get(ex.teacherId) : (slot.teacher?.fullName ?? null),
            change: ex ? (ex.isCancelled ? 'cancelled today' : 'changed for this day') : null,
          }
        })
      return {
        student: fullName(s),
        class: s.schoolClass?.name ?? null,
        date: fmtDate(date),
        schoolDay: !holiday,
        calendarNote: holiday ? `${holiday.title} (${holiday.eventType.replaceAll('_', ' ')})` : null,
        periods,
      }
    },

    async get_fees(a) {
      if (a.studentId === null || a.studentId === undefined) {
        const perChild = []
        let familyKobo = 0
        for (const child of access.students) {
          const r = await feesFor(child)
          familyKobo += r.outstandingKobo
          perChild.push(r.result)
        }
        return {
          children: perChild,
          familyTotalOutstanding: naira(familyKobo),
          howToPay: howToPay(),
        }
      }
      const r = await feesFor(need(a.studentId))
      return { ...r.result, howToPay: howToPay() }
    },

    async get_assignments(a) {
      const s = need(a.studentId)
      if (!s.classId) return { message: 'The student is not assigned to a class.' }
      const now = DateTime.now()
      const q = Assignment.query()
        .where('school_id', schoolId)
        .where('class_id', s.classId)
        .where('published', true)
        .preload('subject')
      if (a.filter === 'due_soon') q.where('deadline', '>=', now.toSQL()!).where('deadline', '<=', now.plus({ days: 14 }).toSQL()!).orderBy('deadline', 'asc')
      else if (a.filter === 'overdue') q.where('deadline', '<', now.toSQL()!).orderBy('deadline', 'desc')
      else q.orderBy('deadline', 'desc')
      const rows = await q.limit(25)
      const subs = rows.length
        ? await AssignmentSubmission.query().where('student_id', s.id).whereIn('assignment_id', rows.map((x) => x.id))
        : []
      const subBy = new Map(subs.map((x) => [x.assignmentId, x]))
      let items = rows.map((x) => {
        const sub = subBy.get(x.id)
        return {
          title: x.title,
          subject: x.subject?.name ?? null,
          deadline: x.deadline ? x.deadline.setZone(TZ).toFormat("cccc d LLLL, h:mm a") : null,
          status: sub?.gradedAt
            ? `graded: ${sub.score ?? '-'} of ${x.maxScore}`
            : sub
              ? 'submitted, awaiting grading'
              : x.deadline && x.deadline < now
                ? 'not submitted (overdue)'
                : 'not submitted yet',
          teacherFeedback: sub?.feedback ?? null,
        }
      })
      if (a.filter === 'overdue') items = items.filter((i) => i.status.startsWith('not submitted'))
      return { student: fullName(s), filter: a.filter, assignments: items.slice(0, 15) }
    },

    async get_exam_results(a) {
      const s = need(a.studentId)
      const attempts = await ExamAttempt.query()
        .where('student_id', s.id)
        .where('status', 'submitted')
        .preload('exam', (e) => e.preload('subject'))
        .orderBy('submitted_at', 'desc')
        .limit(20)
      const results = attempts
        .filter((x) => x.exam?.resultsApprovedAt || x.exam?.showScoreImmediately)
        .map((x) => ({
          exam: x.exam?.title,
          subject: x.exam?.subject?.name ?? null,
          score: `${x.score ?? 0} of ${x.totalMarks}`,
          percent: x.totalMarks ? Math.round(((x.score ?? 0) / x.totalMarks) * 100) : null,
          date: fmtDate(x.submittedAt),
        }))
      const awaiting = attempts.length - results.length
      let openExams: { exam: string; subject: string | null; durationMinutes: number }[] = []
      if (s.classId) {
        const taken = new Set((await ExamAttempt.query().where('student_id', s.id)).map((x) => x.examId))
        const live = await Exam.query()
          .where('school_id', schoolId)
          .where('class_id', s.classId)
          .where('status', 'approved')
          .preload('subject')
        const n = DateTime.now()
        openExams = live
          .filter((e) => !taken.has(e.id) && (!e.opensAt || e.opensAt <= n) && (!e.closesAt || e.closesAt >= n))
          .slice(0, 15)
          .map((e) => ({ exam: e.title, subject: e.subject?.name ?? null, durationMinutes: e.durationMinutes }))
      }
      return {
        student: fullName(s),
        publishedResults: results,
        submittedButNotYetPublished: awaiting,
        openExamsNotYetTaken: openExams,
        whereToTake: 'Students take exams in the CBT Centre in the portal.',
      }
    },

    async get_announcements() {
      const rows = await Announcement.query()
        .where('school_id', schoolId)
        .whereNotNull('published_at')
        .orderBy('pinned', 'desc')
        .orderBy('published_at', 'desc')
        .limit(30)
      const roles = await user.rolesAtSchool(schoolId)
      let ctx: Awaited<ReturnType<typeof buildCallerContext>> | null = null
      const visible: Announcement[] = []
      for (const row of rows) {
        const rules = (row.targetRules ?? []) as TargetRule[]
        const legacy = row.targetRoles as Role[] | null
        if ((!rules || rules.length === 0) && (!legacy || legacy.length === 0)) visible.push(row)
        else if (rules && rules.length > 0) {
          if (!ctx) ctx = await buildCallerContext(user, schoolId)
          if (callerMatchesAnyRule(ctx, rules)) visible.push(row)
        } else if (legacy && legacy.some((r) => roles.includes(r))) visible.push(row)
        if (visible.length >= 8) break
      }
      return visible.map((r) => ({
        title: r.title,
        pinned: r.pinned,
        date: fmtDate(r.publishedAt),
        body: r.body.length > 500 ? r.body.slice(0, 500) + '...' : r.body,
      }))
    },

    async get_school_calendar(a) {
      const start = today()
      let end = start.plus({ days: 30 })
      if (a.range === 'next_90_days') end = start.plus({ days: 90 })
      else if (a.range === 'this_term') {
        const t = await currentTerm()
        if (t?.endsOn) end = t.endsOn.setZone(TZ).plus({ days: 14 })
      }
      const events = await CalendarEvent.query()
        .where('school_id', schoolId)
        .where('starts_on', '<=', end.toISODate()!)
        .where((q) => q.where('ends_on', '>=', start.toISODate()!).orWhere('starts_on', '>=', start.toISODate()!))
        .orderBy('starts_on', 'asc')
        .limit(30)
      return {
        from: fmtDate(start),
        to: fmtDate(end),
        events: events.map((e) => ({
          title: e.title,
          type: e.eventType.replaceAll('_', ' '),
          starts: fmtDate(e.startsOn),
          ends: e.endsOn ? fmtDate(e.endsOn) : null,
          details: e.description,
        })),
      }
    },

    async get_pickup_code(a) {
      const s = need(a.studentId)
      if (!access.wardIds.has(s.id)) {
        return { error: 'Pickup codes are only given to parents.' }
      }
      return {
        student: fullName(s),
        code: pickupCodeFor(schoolId, s.id),
        validFor: `today only (${fmtDate(today())})`,
        note: 'Show this code at the school gate. It changes every day.',
      }
    },
  }

  return async (name: string, args: Record<string, unknown>) => {
    const h = handlers[name]
    if (!h) return { error: `Unknown tool ${name}` }
    return h(args)
  }
}
