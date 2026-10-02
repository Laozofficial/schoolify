import type { HttpContext } from '@adonisjs/core/http'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import Expense from '#models/expense'
import FeeInvoice from '#models/fee_invoice'
import Score from '#models/score'
import Assessment from '#models/assessment'
import Subject from '#models/subject'
import AttendanceDay from '#models/attendance_day'
import AttendanceRecord from '#models/attendance_record'

/**
 * All reports return plain JSON matrices. The frontend renders them and
 * handles CSV export + browser-print for PDF.
 */
export default class ReportsController {
  /** GET /reports/enrollment - students × class × gender counts. */
  async enrollment({ school, serialize }: HttpContext) {
    const [students, classes] = await Promise.all([
      Student.query()
        .where('school_id', school.id)
        .where('is_archived', false),
      SchoolClass.query().where('school_id', school.id).orderBy('name', 'asc'),
    ])

    const rows = classes.map((c) => {
      const inClass = students.filter((s) => s.classId === c.id)
      const male = inClass.filter((s) => s.gender === 'male').length
      const female = inClass.filter((s) => s.gender === 'female').length
      const other = inClass.filter((s) => s.gender === 'other' || !s.gender).length
      return {
        classId: c.id,
        className: c.name,
        male,
        female,
        other,
        total: inClass.length,
      }
    })
    // include unassigned students as a synthetic row
    const unassigned = students.filter((s) => s.classId === null)
    if (unassigned.length > 0) {
      rows.push({
        classId: 0,
        className: 'Unassigned',
        male: unassigned.filter((s) => s.gender === 'male').length,
        female: unassigned.filter((s) => s.gender === 'female').length,
        other: unassigned.filter((s) => s.gender === 'other' || !s.gender).length,
        total: unassigned.length,
      })
    }
    const totals = rows.reduce(
      (acc, r) => {
        acc.male += r.male
        acc.female += r.female
        acc.other += r.other
        acc.total += r.total
        return acc
      },
      { male: 0, female: 0, other: 0, total: 0 }
    )
    return serialize({ rows, totals })
  }

  /**
   * GET /reports/attendance?from&to&classId?
   * Per-day counts (or per-day+session), aggregated over the range.
   */
  async attendance({ school, request, serialize }: HttpContext) {
    const from = String(request.input('from') ?? '')
    const to = String(request.input('to') ?? '')
    const classId = request.input('classId')
    if (!from || !to) {
      return serialize({ rows: [], totals: null, message: 'Provide from & to dates' })
    }

    const dayQuery = AttendanceDay.query()
      .where('school_id', school.id)
      .where('date', '>=', from)
      .where('date', '<=', to)
    if (classId) dayQuery.where('class_id', Number(classId))
    const days = await dayQuery

    const records = await AttendanceRecord.query().whereIn(
      'attendance_day_id',
      days.map((d) => d.id)
    )

    const rows = days.map((d) => {
      const recs = records.filter((r) => r.attendanceDayId === d.id)
      const count = (s: string) => recs.filter((r) => r.status === s).length
      return {
        date: d.date?.toISODate(),
        session: d.session,
        classId: d.classId,
        present: count('present'),
        absent: count('absent'),
        late: count('late'),
        excused: count('excused'),
        sick: count('sick'),
        total: recs.length,
      }
    })

    const totals = {
      present: rows.reduce((s, r) => s + r.present, 0),
      absent: rows.reduce((s, r) => s + r.absent, 0),
      late: rows.reduce((s, r) => s + r.late, 0),
      excused: rows.reduce((s, r) => s + r.excused, 0),
      sick: rows.reduce((s, r) => s + r.sick, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    }
    const attendanceRate =
      totals.total > 0
        ? ((totals.present + totals.late) / totals.total) * 100
        : 0

    return serialize({
      rows,
      totals: { ...totals, attendanceRate: Number(attendanceRate.toFixed(2)) },
    })
  }

  /**
   * GET /reports/finance?termId?
   * Invoiced vs collected vs outstanding + expenses = net.
   */
  async finance({ school, request, serialize }: HttpContext) {
    const termId = request.input('termId')

    const invoiceQuery = FeeInvoice.query()
      .where('school_id', school.id)
      .where('status', '!=', 'cancelled')
    if (termId) invoiceQuery.where('term_id', Number(termId))
    const invoices = await invoiceQuery.preload('payments')

    const invoiced = invoices.reduce((s, i) => s + Number(i.totalAmountKobo), 0)
    const collected = invoices.reduce(
      (s, i) => s + i.payments.reduce((p, r) => p + Number(r.amountKobo), 0),
      0
    )
    const outstanding = invoiced - collected

    const expenses = await Expense.query().where('school_id', school.id)
    const expensesKobo = expenses.reduce((s, e) => s + Number(e.amountKobo), 0)

    // group expenses by category
    const expensesByCategory = new Map<string, number>()
    for (const e of expenses) {
      expensesByCategory.set(
        e.category,
        (expensesByCategory.get(e.category) ?? 0) + Number(e.amountKobo)
      )
    }

    // outstanding by student
    const perStudent: Record<
      string,
      {
        studentId: number
        fullName: string
        admissionNumber: string
        outstandingKobo: number
      }
    > = {}
    for (const inv of invoices) {
      const paid = inv.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
      const remaining = Number(inv.totalAmountKobo) - paid
      if (remaining > 0) {
        const key = String(inv.studentId)
        if (!perStudent[key]) {
          perStudent[key] = {
            studentId: inv.studentId,
            fullName: '',
            admissionNumber: '',
            outstandingKobo: 0,
          }
        }
        perStudent[key].outstandingKobo += remaining
      }
    }
    // fill names
    const students = await Student.query().whereIn(
      'id',
      Object.values(perStudent).map((s) => s.studentId)
    )
    for (const s of students) {
      const key = String(s.id)
      if (perStudent[key]) {
        perStudent[key].fullName = [s.firstName, s.lastName].filter(Boolean).join(' ')
        perStudent[key].admissionNumber = s.admissionNumber
      }
    }

    return serialize({
      summary: {
        invoicedKobo: invoiced,
        collectedKobo: collected,
        outstandingKobo: outstanding,
        expensesKobo,
        netKobo: collected - expensesKobo,
      },
      expensesByCategory: [...expensesByCategory.entries()].map(([category, amountKobo]) => ({
        category,
        amountKobo,
      })),
      outstandingByStudent: Object.values(perStudent).sort(
        (a, b) => b.outstandingKobo - a.outstandingKobo
      ),
    })
  }

  /**
   * GET /reports/academic?termId=&classId?
   * Per-subject averages for the term, filterable by class.
   */
  async academic({ school, request, response, serialize }: HttpContext) {
    const termId = Number(request.input('termId'))
    const classId = request.input('classId')
    if (!termId) return response.badRequest({ message: 'termId required' })

    const studentQuery = Student.query()
      .where('school_id', school.id)
      .where('is_archived', false)
    if (classId) studentQuery.where('class_id', Number(classId))
    const students = await studentQuery
    const studentIds = students.map((s) => s.id)

    if (studentIds.length === 0) {
      return serialize({ subjects: [], totals: { studentCount: 0 } })
    }

    const [assessments, scores, subjects] = await Promise.all([
      Assessment.query().where('school_id', school.id).orderBy('order_index', 'asc'),
      Score.query().where('term_id', termId).whereIn('student_id', studentIds),
      Subject.query().where('school_id', school.id).orderBy('name', 'asc'),
    ])

    const totalWeight = assessments.reduce((s, a) => s + a.weight, 0) || 100

    const subjectSummaries = subjects.map((sub) => {
      const percentages: number[] = []
      for (const sid of studentIds) {
        let weighted = 0
        let hasAny = false
        for (const a of assessments) {
          const s = scores.find(
            (x) => x.studentId === sid && x.subjectId === sub.id && x.assessmentId === a.id
          )
          if (s) {
            hasAny = true
            weighted += ((Number(s.score) / a.maxScore) * 100 * a.weight) / totalWeight
          }
        }
        if (hasAny) percentages.push(weighted)
      }
      const avg =
        percentages.length > 0
          ? percentages.reduce((s, p) => s + p, 0) / percentages.length
          : 0
      const highest = percentages.length > 0 ? Math.max(...percentages) : 0
      const lowest = percentages.length > 0 ? Math.min(...percentages) : 0
      const passed = percentages.filter((p) => p >= 40).length
      return {
        subjectId: sub.id,
        subjectName: sub.name,
        studentCount: percentages.length,
        average: Number(avg.toFixed(2)),
        highest: Number(highest.toFixed(2)),
        lowest: Number(lowest.toFixed(2)),
        passed,
        failed: percentages.length - passed,
      }
    })

    return serialize({
      subjects: subjectSummaries,
      totals: { studentCount: studentIds.length },
    })
  }
}
