import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Exam from '#models/exam'
import ExamQuestion from '#models/exam_question'
import ExamAttempt from '#models/exam_attempt'
import ExamAnswer from '#models/exam_answer'
import Student from '#models/student'

/**
 * The CBT centre - the student-facing exam runner.
 *
 * A student sees only approved exams for their own class. Starting an exam
 * creates an attempt with a per-student shuffled question order (so no two
 * students get the same sequence). Answers autosave as the student goes;
 * submitting auto-grades the objective questions. The score is only
 * revealed on submit when the teacher/admin enabled "show score
 * immediately"; otherwise it stays hidden until results are approved.
 */
export default class CbtController {
  /** The Student row for the logged-in user at this school (or 403). */
  private async currentStudent(ctx: HttpContext): Promise<Student | null> {
    const user = ctx.auth.getUserOrFail()
    const student = await Student.query()
      .where('school_id', ctx.school.id)
      .where('user_id', user.id)
      .where('is_archived', false)
      .preload('schoolClass')
      .first()
    if (!student) {
      ctx.response.forbidden({ message: 'Only students can enter the CBT centre.' })
      return null
    }
    return student
  }

  private isOpen(exam: Exam, now: DateTime): boolean {
    if (exam.opensAt && now < exam.opensAt) return false
    if (exam.closesAt && now > exam.closesAt) return false
    return true
  }

  /**
   * GET /cbt/exams
   * Approved exams for the student's class, each with this student's
   * attempt state so the UI can show Start / Resume / Done.
   */
  async list(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    if (!student.classId) return ctx.serialize([])

    const exams = await Exam.query()
      .where('school_id', ctx.school.id)
      .where('class_id', student.classId)
      .where('status', 'approved')
      .preload('subject')
      .withCount('questions')
      .orderBy('created_at', 'desc')

    const attempts = await ExamAttempt.query()
      .where('student_id', student.id)
      .whereIn(
        'exam_id',
        exams.map((e) => e.id)
      )
    const byExam = new Map(attempts.map((a) => [a.examId, a]))

    const now = DateTime.now()
    return ctx.serialize(
      exams.map((e) => {
        const at = byExam.get(e.id)
        return {
          id: e.id,
          title: e.title,
          subjectName: e.subject?.name ?? null,
          instructions: e.instructions,
          durationMinutes: e.durationMinutes,
          questionCount: Number(e.$extras.questions_count ?? 0),
          opensAt: e.opensAt,
          closesAt: e.closesAt,
          open: this.isOpen(e, now),
          attemptStatus: at?.status ?? 'not_started',
          // Only reveal a score here once results are approved OR the exam
          // was set to show scores immediately and the attempt is submitted.
          score:
            at?.status === 'submitted' && (e.resultsApprovedAt || e.showScoreImmediately)
              ? at.score
              : null,
          totalMarks: at?.totalMarks ?? null,
        }
      })
    )
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  /**
   * POST /cbt/exams/:id/start
   * Create the attempt (or resume an in-progress one). Returns the
   * questions in this student's order, WITHOUT correct answers, plus any
   * answers already saved. A submitted attempt cannot be restarted.
   */
  async start(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const exam = await Exam.query()
      .where('id', Number(ctx.params.id))
      .where('school_id', ctx.school.id)
      .where('status', 'approved')
      .first()
    if (!exam) return ctx.response.notFound({ message: 'Exam not available' })
    if (exam.classId !== student.classId) {
      return ctx.response.forbidden({ message: 'This exam is not for your class.' })
    }
    const now = DateTime.now()
    if (!this.isOpen(exam, now)) {
      return ctx.response.badRequest({ message: 'This exam is not open right now.' })
    }

    const questions = await ExamQuestion.query()
      .where('exam_id', exam.id)
      .orderBy('order_index', 'asc')
    if (questions.length === 0) {
      return ctx.response.badRequest({ message: 'This exam has no questions yet.' })
    }
    const totalMarks = questions.reduce((s, q) => s + Number(q.marks), 0)

    let attempt = await ExamAttempt.query()
      .where('exam_id', exam.id)
      .where('student_id', student.id)
      .first()

    if (attempt && attempt.status === 'submitted') {
      return ctx.response.badRequest({ message: 'You have already submitted this exam.' })
    }

    if (!attempt) {
      const order = exam.shuffleQuestions
        ? this.shuffle(questions.map((q) => q.id))
        : questions.map((q) => q.id)
      attempt = await ExamAttempt.create({
        examId: exam.id,
        studentId: student.id,
        startedAt: now,
        status: 'in_progress',
        totalMarks,
        questionOrder: order,
      })
    }

    // Order the questions per this attempt's saved order.
    const qById = new Map(questions.map((q) => [q.id, q]))
    const ordered = (attempt.questionOrder ?? [])
      .map((id) => qById.get(id))
      .filter((q): q is ExamQuestion => !!q)

    const saved = await ExamAnswer.query().where('attempt_id', attempt.id)
    const savedByQ = new Map(saved.map((a) => [a.questionId, a.selectedIndex]))

    return ctx.serialize({
      attemptId: attempt.id,
      examTitle: exam.title,
      instructions: exam.instructions,
      durationMinutes: exam.durationMinutes,
      startedAt: attempt.startedAt,
      questions: ordered.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        marks: q.marks,
        selectedIndex: savedByQ.get(q.id) ?? null,
      })),
    })
  }

  /** Load the caller's own in-progress attempt, or respond and return null. */
  private async ownAttempt(ctx: HttpContext, student: Student): Promise<ExamAttempt | null> {
    const attempt = await ExamAttempt.query()
      .where('id', Number(ctx.params.attemptId))
      .where('student_id', student.id)
      .first()
    if (!attempt) {
      ctx.response.notFound({ message: 'Attempt not found' })
      return null
    }
    return attempt
  }

  /**
   * PATCH /cbt/attempts/:attemptId/answer { questionId, selectedIndex }
   * Autosave a single answer. No-op once the attempt is submitted.
   */
  async answer(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const attempt = await this.ownAttempt(ctx, student)
    if (!attempt) return
    if (attempt.status === 'submitted') {
      return ctx.response.badRequest({ message: 'This attempt is already submitted.' })
    }
    const questionId = Number(ctx.request.input('questionId'))
    const selectedIndex =
      ctx.request.input('selectedIndex') === null
        ? null
        : Number(ctx.request.input('selectedIndex'))

    // Question must belong to this exam.
    const question = await ExamQuestion.query()
      .where('id', questionId)
      .where('exam_id', attempt.examId)
      .first()
    if (!question) return ctx.response.badRequest({ message: 'Unknown question' })

    const existing = await ExamAnswer.query()
      .where('attempt_id', attempt.id)
      .where('question_id', questionId)
      .first()
    if (existing) {
      existing.selectedIndex = selectedIndex
      await existing.save()
    } else {
      await ExamAnswer.create({
        attemptId: attempt.id,
        questionId,
        selectedIndex,
        isCorrect: false,
      })
    }
    return ctx.serialize({ ok: true })
  }

  /**
   * POST /cbt/attempts/:attemptId/submit
   * Grade the objective answers, finalise the attempt, and return the
   * score only when the exam is set to show scores immediately.
   */
  async submit(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const attempt = await this.ownAttempt(ctx, student)
    if (!attempt) return
    if (attempt.status === 'submitted') {
      return ctx.response.badRequest({ message: 'Already submitted.' })
    }
    const exam = await Exam.query().where('id', attempt.examId).firstOrFail()
    const questions = await ExamQuestion.query().where('exam_id', attempt.examId)

    const answers = await ExamAnswer.query().where('attempt_id', attempt.id)
    const answerByQ = new Map(answers.map((a) => [a.questionId, a]))

    let score = 0
    for (const q of questions) {
      const ans = answerByQ.get(q.id)
      const isCorrect = !!ans && ans.selectedIndex === q.correctIndex
      if (ans) {
        ans.isCorrect = isCorrect
        await ans.save()
      }
      if (isCorrect) score += Number(q.marks)
    }
    // Recompute totalMarks defensively in case questions changed.
    attempt.totalMarks = questions.reduce((s, q) => s + Number(q.marks), 0)
    attempt.score = score
    attempt.status = 'submitted'
    attempt.submittedAt = DateTime.now()
    await attempt.save()

    const reveal = exam.showScoreImmediately
    return ctx.serialize({
      submitted: true,
      showScore: reveal,
      score: reveal ? score : null,
      totalMarks: reveal ? attempt.totalMarks : null,
    })
  }

  /**
   * GET /cbt/results
   * The student's own submitted attempts, showing scores only for exams
   * where results are approved (or that were set to show immediately).
   */
  async myResults(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const attempts = await ExamAttempt.query()
      .where('student_id', student.id)
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
}
