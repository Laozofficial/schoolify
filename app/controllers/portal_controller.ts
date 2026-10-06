import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import User from '#models/user'
import Student from '#models/student'
import TimetableSlot from '#models/timetable_slot'
import FeeInvoice from '#models/fee_invoice'
import Payment from '#models/payment'
import Assignment from '#models/assignment'
import AssignmentSubmission from '#models/assignment_submission'
import ExamAttempt from '#models/exam_attempt'
import Term from '#models/term'
import { pickupCodeFor, pickupQrFor, verifyPickupCode } from '#services/pickup_code'
import InvoiceInstallment from '#models/invoice_installment'
import { scheduleState } from '#services/installments'
import { initializePayment, isPaymentConfigured } from '#services/payment_gateway'
import env from '#start/env'

/**
 * Self-service endpoints for the student + parent portal. Every route is
 * scoped to the caller: a student sees only their own record, a parent
 * only their linked wards. Staff may also read (handy for support). These
 * intentionally bypass the RBAC permission layer - access is by
 * relationship, not by granted permission.
 */
export default class PortalController {
  /** Resolve the students the caller may view, or null if none. */
  private async accessibleStudentIds(user: User, schoolId: number): Promise<number[]> {
    const roles = await user.rolesAtSchool(schoolId)
    const isStaff = roles.some((r) =>
      ['super_admin', 'admin', 'teacher', 'accountant'].includes(r)
    )
    if (isStaff) {
      const all = await Student.query().where('school_id', schoolId).select('id')
      return all.map((s) => s.id)
    }
    const ids = new Set<number>()
    // Student self
    const self = await Student.query()
      .where('school_id', schoolId)
      .where('user_id', user.id)
      .select('id')
    for (const s of self) ids.add(s.id)
    // Parent wards
    if (roles.includes('parent')) {
      const wards = await user.related('wards').query().where('school_id', schoolId)
      for (const w of wards) ids.add(w.id)
    }
    return [...ids]
  }

  private async guard(
    ctx: HttpContext,
    studentId: number
  ): Promise<Student | null> {
    const user = ctx.auth.getUserOrFail()
    const allowed = await this.accessibleStudentIds(user, ctx.school.id)
    if (!allowed.includes(studentId)) {
      ctx.response.forbidden({ message: 'Not your record' })
      return null
    }
    return Student.query()
      .where('id', studentId)
      .where('school_id', ctx.school.id)
      .preload('schoolClass')
      .first()
  }

  /**
   * GET /portal/wards
   * The students the caller may view: a parent's wards, or the student
   * themselves. Each card carries enough to drive the portal switcher.
   */
  async wards({ auth, school, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const ids = await this.accessibleStudentIds(user, school.id)
    if (ids.length === 0) return serialize([])
    const roles = await user.rolesAtSchool(school.id)
    const isParent = roles.includes('parent')
    const students = await Student.query()
      .whereIn('id', ids)
      .where('is_archived', false)
      .preload('schoolClass')
      .orderBy('last_name', 'asc')
    return serialize(
      students.map((s) => ({
        id: s.id,
        fullName: [s.firstName, s.lastName].filter(Boolean).join(' '),
        admissionNumber: s.admissionNumber,
        className: s.schoolClass?.name ?? null,
        photoUrl: s.photoUrl,
        isSelf: s.userId === user.id,
        // Only parents get a pickup code (they collect the child). Rotates
        // daily; the gate verifies it before releasing the student.
        pickupCode: isParent ? pickupCodeFor(school.id, s.id) : null,
        pickupQr: isParent ? pickupQrFor(school.id, s.id) : null,
      }))
    )
  }

  /** GET /portal/students/:studentId/timetable - class weekly grid. */
  async timetable(ctx: HttpContext) {
    const studentId = Number(ctx.params.studentId)
    const student = await this.guard(ctx, studentId)
    if (!student) return
    if (!student.classId) return ctx.serialize({ slots: [] })
    const slots = await TimetableSlot.query()
      .where('school_id', ctx.school.id)
      .where('class_id', student.classId)
      .preload('period')
      .preload('subject')
      .preload('teacher')
    return ctx.serialize({
      className: student.schoolClass?.name ?? null,
      slots: slots.map((s) => ({
        id: s.id,
        dayOfWeek: s.dayOfWeek,
        periodId: s.periodId,
        periodName: s.period?.name ?? null,
        startTime: s.period?.startTime ?? null,
        endTime: s.period?.endTime ?? null,
        subjectName: s.subject?.name ?? null,
        teacherName: s.teacher?.fullName ?? null,
      })),
    })
  }

  /** GET /portal/students/:studentId/invoices - fees + outstanding. */
  async invoices(ctx: HttpContext) {
    const studentId = Number(ctx.params.studentId)
    const student = await this.guard(ctx, studentId)
    if (!student) return

    const invoices = await FeeInvoice.query()
      .where('school_id', ctx.school.id)
      .where('student_id', studentId)
      .preload('term')
      .orderBy('issued_on', 'desc')

    const invoiceIds = invoices.map((i) => i.id)
    const payments = invoiceIds.length
      ? await Payment.query().whereIn('invoice_id', invoiceIds)
      : []
    const paidByInvoice = new Map<number, number>()
    for (const p of payments) {
      paidByInvoice.set(
        p.invoiceId,
        (paidByInvoice.get(p.invoiceId) ?? 0) + Number(p.amountKobo)
      )
    }

    const plans = invoiceIds.length ? await InvoiceInstallment.query().whereIn('invoice_id', invoiceIds) : []

    let outstanding = 0
    const rows = invoices.map((inv) => {
      const total = Number(inv.totalAmountKobo)
      const paid = paidByInvoice.get(inv.id) ?? 0
      const bal = Math.max(0, total - paid)
      if (inv.status !== 'paid') outstanding += bal
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        termName: inv.term ? `${inv.term.session} · ${inv.term.name}` : null,
        totalKobo: total,
        paidKobo: paid,
        balanceKobo: bal,
        status: inv.status,
        issuedOn: inv.issuedOn,
        dueOn: inv.dueOn,
        installments: scheduleState(
          plans.filter((p) => p.invoiceId === inv.id),
          paid
        ),
      }
    })

    return ctx.serialize({ invoices: rows, outstandingKobo: outstanding })
  }

  /** GET /portal/students/:studentId/assignments - class assignments +
   * this student's submission status. `canSubmit` is true only when the
   * caller IS the student (parents view read-only). */
  async assignments(ctx: HttpContext) {
    const studentId = Number(ctx.params.studentId)
    const student = await this.guard(ctx, studentId)
    if (!student) return
    if (!student.classId) return ctx.serialize({ canSubmit: false, assignments: [] })

    const rows = await Assignment.query()
      .where('school_id', ctx.school.id)
      .where('class_id', student.classId)
      .where('published', true)
      .preload('subject')
      .orderBy('deadline', 'desc')
      .limit(50)

    const subs = rows.length
      ? await AssignmentSubmission.query()
          .where('student_id', studentId)
          .whereIn(
            'assignment_id',
            rows.map((a) => a.id)
          )
      : []
    const subByAssignment = new Map(subs.map((s) => [s.assignmentId, s]))

    const now = DateTime.now()
    const canSubmit = student.userId === ctx.auth.user?.id
    return ctx.serialize({
      canSubmit,
      assignments: rows.map((a) => {
        const sub = subByAssignment.get(a.id)
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          subjectName: a.subject?.name ?? null,
          deadline: a.deadline,
          maxScore: a.maxScore,
          overdue: a.deadline ? a.deadline < now : false,
          submission: sub
            ? {
                content: sub.content,
                attachmentUrl: sub.attachmentUrl,
                submittedAt: sub.submittedAt,
                score: sub.score,
                feedback: sub.feedback,
                gradedAt: sub.gradedAt,
              }
            : null,
        }
      }),
    })
  }

  /**
   * GET /portal/students/:studentId/exams - the student's submitted exam
   * attempts. Scores are only revealed once the admin has published the
   * results (or the exam was set to show scores immediately).
   */
  async exams(ctx: HttpContext) {
    const studentId = Number(ctx.params.studentId)
    const student = await this.guard(ctx, studentId)
    if (!student) return
    const attempts = await ExamAttempt.query()
      .where('student_id', studentId)
      .where('status', 'submitted')
      .preload('exam', (e) => e.preload('subject'))
      .orderBy('submitted_at', 'desc')
    return ctx.serialize(
      attempts.map((a) => {
        const visible = !!a.exam?.resultsApprovedAt || !!a.exam?.showScoreImmediately
        return {
          id: a.id,
          examTitle: a.exam?.title ?? null,
          subjectName: a.exam?.subject?.name ?? null,
          submittedAt: a.submittedAt,
          score: visible ? a.score : null,
          totalMarks: visible ? a.totalMarks : null,
          published: !!a.exam?.resultsApprovedAt,
        }
      })
    )
  }

  /**
   * POST /schools/:sid/pickup/verify { studentId, code }
   * Gate/front-desk check: does the supplied code match today's pickup
   * code for the student? Staff only.
   */
  async verifyPickup(ctx: HttpContext) {
    const studentId = Number(ctx.request.input('studentId'))
    const code = String(ctx.request.input('code') ?? '')
    const student = await Student.query()
      .where('id', studentId)
      .where('school_id', ctx.school.id)
      .preload('schoolClass')
      .first()
    if (!student) return ctx.response.notFound({ message: 'Student not found' })

    const valid = verifyPickupCode(ctx.school.id, studentId, code)
    return ctx.serialize({
      valid,
      student: {
        id: student.id,
        fullName: [student.firstName, student.lastName].filter(Boolean).join(' '),
        admissionNumber: student.admissionNumber,
        className: student.schoolClass?.name ?? null,
        photoUrl: student.photoUrl,
      },
    })
  }

  /**
   * POST /portal/students/:studentId/invoices/:invoiceId/pay
   * Starts an online payment for the invoice's outstanding balance via
   * payment.twelveai.app and returns the checkout URL to redirect to.
   * The reference encodes the invoice so the webhook can reconcile it.
   */
  async payInvoice(ctx: HttpContext) {
    const studentId = Number(ctx.params.studentId)
    const student = await this.guard(ctx, studentId)
    if (!student) return
    if (!isPaymentConfigured()) {
      return ctx.response.serviceUnavailable({
        message: 'Online payments are not enabled yet. Please pay at the school office.',
      })
    }

    const invoice = await FeeInvoice.query()
      .where('id', Number(ctx.params.invoiceId))
      .where('school_id', ctx.school.id)
      .where('student_id', studentId)
      .preload('payments')
      .first()
    if (!invoice) return ctx.response.notFound({ message: 'Invoice not found' })

    const paid = invoice.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
    const outstanding = Number(invoice.totalAmountKobo) - paid
    if (outstanding <= 0) {
      return ctx.response.badRequest({ message: 'This invoice is already fully paid.' })
    }

    const user = ctx.auth.getUserOrFail()
    const reference = `sch${ctx.school.id}-inv${invoice.id}-${Date.now()}`
    const frontend = env.get('FRONTEND_URL') ?? 'http://localhost:3000'

    try {
      const res = await initializePayment({
        amountKobo: outstanding,
        email: user.email,
        reference,
        callbackUrl: `${frontend}/portal?paid=${invoice.id}`,
        metadata: {
          invoiceId: invoice.id,
          studentId,
          schoolId: ctx.school.id,
        },
      })
      return ctx.serialize({
        authorizationUrl: res.authorizationUrl,
        reference: res.reference,
        amountKobo: outstanding,
      })
    } catch (e) {
      return ctx.response.badGateway({
        message: (e as Error).message ?? 'Could not start payment',
      })
    }
  }

  /** GET /portal/terms - terms list (for report card picker). */
  async terms({ school, serialize }: HttpContext) {
    const rows = await Term.query()
      .where('school_id', school.id)
      .orderBy('starts_on', 'desc')
    return serialize(
      rows.map((t) => ({
        id: t.id,
        session: t.session,
        name: t.name,
        isCurrent: t.isCurrent,
      }))
    )
  }
}
