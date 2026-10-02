import Notification from '#models/notification'
import Student from '#models/student'
import ParentStudent from '#models/parent_student'

interface NotifyInput {
  schoolId: number
  kind: string
  title: string
  body?: string | null
  data?: Record<string, unknown> | null
}

/** Create one notification per user id (deduped). */
export async function notifyUsers(userIds: number[], input: NotifyInput) {
  const unique = [...new Set(userIds)].filter((id) => Number.isFinite(id))
  for (const userId of unique) {
    await Notification.create({
      userId,
      schoolId: input.schoolId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? null,
    })
  }
}

/**
 * Resolve the audience for a student-scoped event: the student's own login
 * (if any) plus every linked parent. Used for fees, results, etc.
 */
export async function studentAudience(studentId: number): Promise<number[]> {
  const [student, links] = await Promise.all([
    Student.query().where('id', studentId).select('id', 'user_id').first(),
    ParentStudent.query().where('student_id', studentId).select('parent_user_id'),
  ])
  const ids: number[] = []
  if (student?.userId) ids.push(student.userId)
  for (const l of links) ids.push(l.parentUserId)
  return ids
}

function naira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })
}

/** Notify a student + their parents that a new invoice was issued. */
export async function notifyInvoiceIssued(opts: {
  schoolId: number
  studentId: number
  invoiceId: number
  invoiceNumber: string
  totalKobo: number
  dueOn?: string | null
}) {
  const audience = await studentAudience(opts.studentId)
  if (audience.length === 0) return
  const due = opts.dueOn ? ` Due ${opts.dueOn}.` : ''
  await notifyUsers(audience, {
    schoolId: opts.schoolId,
    kind: 'fee_invoice',
    title: `New invoice ${opts.invoiceNumber}`,
    body: `${naira(opts.totalKobo)} has been billed.${due} Open Fees to pay.`,
    data: { invoiceId: opts.invoiceId, kind: 'fee_invoice' },
  })
}

/** Notify a student + their parents that exam results are now available. */
export async function notifyExamResultsApproved(opts: {
  schoolId: number
  studentId: number
  examTitle: string
  score?: number | null
  totalMarks?: number | null
}) {
  const audience = await studentAudience(opts.studentId)
  if (audience.length === 0) return
  const scoreLine =
    opts.score != null && opts.totalMarks != null
      ? ` Scored ${opts.score}/${opts.totalMarks}.`
      : ''
  await notifyUsers(audience, {
    schoolId: opts.schoolId,
    kind: 'exam_results',
    title: `Exam results published: ${opts.examTitle}`,
    body: `Results for "${opts.examTitle}" are now available.${scoreLine}`,
    data: { kind: 'exam_results' },
  })
}

/** Notify a student + their parents that a payment was recorded. */
export async function notifyPaymentRecorded(opts: {
  schoolId: number
  studentId: number
  invoiceNumber: string
  amountKobo: number
  balanceKobo: number
}) {
  const audience = await studentAudience(opts.studentId)
  if (audience.length === 0) return
  const bal =
    opts.balanceKobo > 0
      ? ` Balance: ${naira(opts.balanceKobo)}.`
      : ' Fully paid. Thank you!'
  await notifyUsers(audience, {
    schoolId: opts.schoolId,
    kind: 'payment',
    title: `Payment received · ${opts.invoiceNumber}`,
    body: `${naira(opts.amountKobo)} recorded.${bal}`,
    data: { kind: 'payment' },
  })
}
