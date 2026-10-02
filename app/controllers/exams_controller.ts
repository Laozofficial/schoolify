import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Exam from '#models/exam'
import ExamQuestion from '#models/exam_question'
import ExamAttempt from '#models/exam_attempt'
import User from '#models/user'
import { teacherScope, canTeachPair, type TeacherScope } from '#services/teacher_scope'
import { notifyUsers, notifyExamResultsApproved } from '#services/notify'

/**
 * Exam / CBT authoring + review.
 *
 * - Teachers create objective exams (MCQ + True/False) only for the
 *   (class, subject) pairs they actually teach, add questions with the
 *   correct answer, then submit the exam for admin review.
 * - Admins approve or reject each exam (per-exam), decide whether the
 *   score shows to the student immediately on submit, and later approve
 *   the results so parents/students can see scores.
 *
 * The CBT runner (student side) lives in cbt_controller.ts.
 */
export default class ExamsController {
  private async scope(ctx: HttpContext): Promise<{ user: User; scope: TeacherScope }> {
    const user = ctx.auth.getUserOrFail()
    const scope = await teacherScope(user, ctx.school.id)
    return { user, scope }
  }

  /** Load an exam in-school, or respond 404 and return null. */
  private async findExam(ctx: HttpContext, id: number): Promise<Exam | null> {
    const exam = await Exam.query()
      .where('id', id)
      .where('school_id', ctx.school.id)
      .preload('schoolClass')
      .preload('subject')
      .preload('teacher')
      .first()
    if (!exam) {
      ctx.response.notFound({ message: 'Exam not found' })
      return null
    }
    return exam
  }

  /**
   * Can this caller manage (edit/delete/submit) the exam? Admins always;
   * a teacher only if they own it AND still teach that class+subject.
   */
  private canManage(scope: TeacherScope, exam: Exam, userId: number): boolean {
    if (scope.unscoped) return true
    if (exam.teacherId !== userId) return false
    return canTeachPair(scope, exam.classId, exam.subjectId)
  }

  private serializeExam(exam: Exam, questionCount?: number) {
    return {
      id: exam.id,
      title: exam.title,
      instructions: exam.instructions,
      classId: exam.classId,
      className: exam.schoolClass?.name ?? null,
      subjectId: exam.subjectId,
      subjectName: exam.subject?.name ?? null,
      teacherId: exam.teacherId,
      teacherName: exam.teacher?.fullName ?? null,
      termId: exam.termId,
      durationMinutes: exam.durationMinutes,
      shuffleQuestions: exam.shuffleQuestions,
      showScoreImmediately: exam.showScoreImmediately,
      status: exam.status,
      reviewNote: exam.reviewNote,
      opensAt: exam.opensAt,
      closesAt: exam.closesAt,
      resultsApprovedAt: exam.resultsApprovedAt,
      questionCount: questionCount ?? undefined,
      createdAt: exam.createdAt,
    }
  }

  /**
   * GET /exams
   * Admins see every exam in the school; teachers see only their own.
   * Optional filters: ?classId= &subjectId= &status=
   */
  async index(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const q = Exam.query()
      .where('school_id', ctx.school.id)
      .preload('schoolClass')
      .preload('subject')
      .preload('teacher')
      .withCount('questions')
      .orderBy('created_at', 'desc')

    if (!scope.unscoped) q.where('teacher_id', user.id)

    const classId = Number(ctx.request.input('classId'))
    if (Number.isFinite(classId) && classId > 0) q.where('class_id', classId)
    const subjectId = Number(ctx.request.input('subjectId'))
    if (Number.isFinite(subjectId) && subjectId > 0) q.where('subject_id', subjectId)
    const status = ctx.request.input('status')
    if (status) q.where('status', String(status))

    const exams = await q
    return ctx.serialize(
      exams.map((e) => this.serializeExam(e, Number(e.$extras.questions_count ?? 0)))
    )
  }

  /** GET /exams/:id - full exam with its questions (answers included for
   * the owner/admin only). */
  async show(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    const questions = await ExamQuestion.query()
      .where('exam_id', exam.id)
      .orderBy('order_index', 'asc')
    return ctx.serialize({
      ...this.serializeExam(exam, questions.length),
      questions: questions.map((qq) => ({
        id: qq.id,
        type: qq.type,
        prompt: qq.prompt,
        options: qq.options,
        correctIndex: qq.correctIndex,
        marks: qq.marks,
        orderIndex: qq.orderIndex,
        topic: qq.topic,
        difficulty: qq.difficulty,
        explanation: qq.explanation,
        aiGenerated: qq.aiGenerated,
      })),
    })
  }

  /**
   * POST /exams
   * Create a draft exam. A teacher may only target a (class, subject) they
   * teach; an admin may target anything and may set an explicit teacherId.
   */
  async store(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const classId = Number(ctx.request.input('classId'))
    const subjectId = Number(ctx.request.input('subjectId'))
    if (!Number.isFinite(classId) || !Number.isFinite(subjectId)) {
      return ctx.response.badRequest({ message: 'classId and subjectId are required' })
    }
    if (!canTeachPair(scope, classId, subjectId)) {
      return ctx.response.forbidden({
        message: 'You can only set exams for a class and subject you teach.',
      })
    }
    // Admin may assign to a specific teacher; teacher owns their own.
    let teacherId = user.id
    if (scope.unscoped && ctx.request.input('teacherId')) {
      teacherId = Number(ctx.request.input('teacherId'))
    }

    const exam = await Exam.create({
      schoolId: ctx.school.id,
      classId,
      subjectId,
      teacherId,
      termId: ctx.request.input('termId') ? Number(ctx.request.input('termId')) : null,
      title: String(ctx.request.input('title') ?? 'Untitled exam').trim(),
      instructions: ctx.request.input('instructions') ?? null,
      durationMinutes: Number(ctx.request.input('durationMinutes')) || 30,
      shuffleQuestions: ctx.request.input('shuffleQuestions') !== false,
      showScoreImmediately: ctx.request.input('showScoreImmediately') === true,
      status: 'draft',
      opensAt: this.parseDate(ctx.request.input('opensAt')),
      closesAt: this.parseDate(ctx.request.input('closesAt')),
    })
    await exam.load('schoolClass')
    await exam.load('subject')
    await exam.load('teacher')
    return ctx.serialize(this.serializeExam(exam, 0))
  }

  private parseDate(v: unknown): DateTime | null {
    if (!v) return null
    const d = DateTime.fromISO(String(v))
    return d.isValid ? d : null
  }

  /** PATCH /exams/:id - edit exam meta. Only while draft or rejected;
   * approved exams are locked (re-submit resets to review). */
  async update(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    if (exam.status === 'approved' && !scope.unscoped) {
      return ctx.response.badRequest({
        message: 'This exam is approved and locked. Ask an admin to reopen it.',
      })
    }
    const req = ctx.request
    if (req.input('title') !== undefined) exam.title = String(req.input('title')).trim()
    if (req.input('instructions') !== undefined) exam.instructions = req.input('instructions')
    if (req.input('durationMinutes') !== undefined)
      exam.durationMinutes = Number(req.input('durationMinutes')) || exam.durationMinutes
    if (req.input('shuffleQuestions') !== undefined)
      exam.shuffleQuestions = req.input('shuffleQuestions') === true
    if (req.input('showScoreImmediately') !== undefined)
      exam.showScoreImmediately = req.input('showScoreImmediately') === true
    if (req.input('termId') !== undefined)
      exam.termId = req.input('termId') ? Number(req.input('termId')) : null
    if (req.input('opensAt') !== undefined) exam.opensAt = this.parseDate(req.input('opensAt'))
    if (req.input('closesAt') !== undefined) exam.closesAt = this.parseDate(req.input('closesAt'))
    await exam.save()
    return ctx.serialize(this.serializeExam(exam))
  }

  /** DELETE /exams/:id */
  async destroy(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    await exam.delete()
    return ctx.serialize({ ok: true })
  }

  /**
   * PUT /exams/:id/questions - replace the whole question set.
   * Body: { questions: [{ type, prompt, options[], correctIndex, marks }] }
   * For True/False we normalise options to ['True','False'].
   */
  async setQuestions(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    if (exam.status === 'approved' && !scope.unscoped) {
      return ctx.response.badRequest({
        message: 'This exam is approved and locked.',
      })
    }
    const raw = ctx.request.input('questions')
    if (!Array.isArray(raw)) {
      return ctx.response.badRequest({ message: 'questions must be an array' })
    }

    const rows: Array<{
      type: string
      prompt: string
      options: string[]
      correctIndex: number
      marks: number
      topic: string | null
      difficulty: string | null
      explanation: string | null
      aiGenerated: boolean
    }> = []
    for (const [i, q] of raw.entries()) {
      const type = q?.type === 'true_false' ? 'true_false' : 'mcq'
      const prompt = String(q?.prompt ?? '').trim()
      let options: string[]
      let correctIndex = Number(q?.correctIndex)
      if (type === 'true_false') {
        options = ['True', 'False']
        if (correctIndex !== 0 && correctIndex !== 1) correctIndex = 0
      } else {
        const rawOptions: string[] = (Array.isArray(q?.options) ? q.options : []).map(
          (o: unknown) => String(o ?? '').trim()
        )
        // Blank options are dropped; remap the correct index so it still
        // points at the same option the teacher marked.
        const chosen = rawOptions[correctIndex]
        options = rawOptions.filter((o) => o.length > 0)
        correctIndex = chosen ? rawOptions.slice(0, correctIndex).filter((o) => o.length > 0).length : -1
        if (options.length < 2) {
          return ctx.response.badRequest({
            message: `Question ${i + 1} needs at least two options.`,
          })
        }
        if (!(correctIndex >= 0 && correctIndex < options.length)) {
          return ctx.response.badRequest({
            message: `Question ${i + 1} has no valid correct answer selected.`,
          })
        }
      }
      if (!prompt) {
        return ctx.response.badRequest({ message: `Question ${i + 1} is missing its text.` })
      }
      const marks = Number(q?.marks) > 0 ? Number(q.marks) : 1
      const difficulty = ['easy', 'medium', 'hard'].includes(q?.difficulty) ? q.difficulty : null
      rows.push({
        type,
        prompt,
        options,
        correctIndex,
        marks,
        topic: q?.topic ? String(q.topic).trim().slice(0, 120) || null : null,
        difficulty,
        explanation: q?.explanation ? String(q.explanation).trim() || null : null,
        aiGenerated: q?.aiGenerated === true,
      })
    }

    // Replace-in-place: wipe and re-insert with fresh order, atomically so a
    // failure never leaves an exam half-saved.
    await db.transaction(async (trx) => {
      await ExamQuestion.query({ client: trx }).where('exam_id', exam.id).delete()
      for (const [i, r] of rows.entries()) {
        await ExamQuestion.create(
          {
            examId: exam.id,
            type: r.type,
            prompt: r.prompt,
            options: r.options,
            correctIndex: r.correctIndex,
            marks: r.marks,
            orderIndex: i,
            topic: r.topic,
            difficulty: r.difficulty,
            explanation: r.explanation,
            aiGenerated: r.aiGenerated,
          },
          { client: trx }
        )
      }
    })
    return ctx.serialize({ ok: true, count: rows.length })
  }

  /**
   * POST /exams/:id/submit - teacher submits the exam for admin review.
   * Requires at least one question. Moves draft/rejected -> submitted and
   * notifies the school admins.
   */
  async submit(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    const count = await ExamQuestion.query().where('exam_id', exam.id).count('* as total')
    if (Number(count[0].$extras.total) === 0) {
      return ctx.response.badRequest({ message: 'Add at least one question before submitting.' })
    }
    exam.status = 'submitted'
    exam.reviewNote = null
    await exam.save()

    // Notify admins there is an exam awaiting review.
    const admins = await this.schoolAdminUserIds(ctx.school.id)
    await notifyUsers(admins, {
      schoolId: ctx.school.id,
      kind: 'exam_review',
      title: `Exam awaiting review: ${exam.title}`,
      body: `${exam.teacher?.fullName ?? 'A teacher'} submitted "${exam.title}" for approval.`,
      data: { kind: 'exam_review', examId: exam.id },
    })
    return ctx.serialize(this.serializeExam(exam))
  }

  /**
   * POST /exams/:id/review { decision: 'approve' | 'reject', note? }
   * Admin only. Approve makes the exam available in the CBT centre;
   * reject sends it back to the teacher with a note.
   */
  async review(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    if (!scope.unscoped) {
      return ctx.response.forbidden({ message: 'Only admins can review exams.' })
    }
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    const decision = String(ctx.request.input('decision'))
    const note = ctx.request.input('note') ?? null
    if (decision === 'approve') {
      exam.status = 'approved'
      exam.reviewNote = null
    } else if (decision === 'reject') {
      exam.status = 'rejected'
      exam.reviewNote = note
    } else {
      return ctx.response.badRequest({ message: 'decision must be approve or reject' })
    }
    exam.reviewedByUserId = user.id
    exam.reviewedAt = DateTime.now()
    await exam.save()

    // Tell the owning teacher the outcome.
    await notifyUsers([exam.teacherId], {
      schoolId: ctx.school.id,
      kind: 'exam_review_result',
      title:
        decision === 'approve'
          ? `Exam approved: ${exam.title}`
          : `Exam needs changes: ${exam.title}`,
      body:
        decision === 'approve'
          ? `"${exam.title}" is now live in the CBT centre.`
          : `"${exam.title}" was sent back${note ? `: ${note}` : '.'}`,
      data: { kind: 'exam_review_result', examId: exam.id },
    })
    return ctx.serialize(this.serializeExam(exam))
  }

  /**
   * POST /exams/:id/reopen - admin unlocks an approved exam back to draft
   * so the teacher can edit it again.
   */
  async reopen(ctx: HttpContext) {
    const { scope } = await this.scope(ctx)
    if (!scope.unscoped) {
      return ctx.response.forbidden({ message: 'Only admins can reopen exams.' })
    }
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    exam.status = 'draft'
    await exam.save()
    return ctx.serialize(this.serializeExam(exam))
  }

  /**
   * POST /exams/:id/approve-results - admin publishes results so
   * students + parents can see their scores. Notifies each student that
   * has a submitted attempt.
   */
  async approveResults(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    if (!scope.unscoped) {
      return ctx.response.forbidden({ message: 'Only admins can approve results.' })
    }
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    exam.resultsApprovedAt = DateTime.now()
    exam.resultsApprovedByUserId = user.id
    await exam.save()

    const attempts = await ExamAttempt.query()
      .where('exam_id', exam.id)
      .where('status', 'submitted')
    for (const a of attempts) {
      await notifyExamResultsApproved({
        schoolId: ctx.school.id,
        studentId: a.studentId,
        examTitle: exam.title,
        score: a.score,
        totalMarks: a.totalMarks,
      })
    }
    return ctx.serialize(this.serializeExam(exam))
  }

  /**
   * GET /exams/:id/results - grade sheet for one exam (admin, or the
   * owning teacher). One row per student attempt.
   */
  async results(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    const attempts = await ExamAttempt.query()
      .where('exam_id', exam.id)
      .preload('student')
      .orderBy('score', 'desc')
    return ctx.serialize({
      ...this.serializeExam(exam),
      resultsApproved: !!exam.resultsApprovedAt,
      attempts: attempts.map((a) => ({
        id: a.id,
        studentId: a.studentId,
        studentName: a.student
          ? [a.student.firstName, a.student.lastName].filter(Boolean).join(' ')
          : null,
        admissionNumber: a.student?.admissionNumber ?? null,
        status: a.status,
        score: a.score,
        totalMarks: a.totalMarks,
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
      })),
    })
  }

  /**
   * GET /exams/reusable?subjectId=&classId= - past approved exams whose
   * questions can be copied into a new draft. Scoped to what the caller
   * may author.
   */
  async reusable(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const q = Exam.query()
      .where('school_id', ctx.school.id)
      .preload('schoolClass')
      .preload('subject')
      .withCount('questions')
      .orderBy('created_at', 'desc')
      .limit(100)
    if (!scope.unscoped) q.where('teacher_id', user.id)
    const subjectId = Number(ctx.request.input('subjectId'))
    if (Number.isFinite(subjectId) && subjectId > 0) q.where('subject_id', subjectId)
    const exams = await q
    return ctx.serialize(
      exams
        .filter((e) => Number(e.$extras.questions_count ?? 0) > 0)
        .map((e) => ({
          id: e.id,
          title: e.title,
          className: e.schoolClass?.name ?? null,
          subjectName: e.subject?.name ?? null,
          questionCount: Number(e.$extras.questions_count ?? 0),
          createdAt: e.createdAt,
        }))
    )
  }

  /**
   * POST /exams/:id/import-questions { sourceExamId }
   * Copy the question set from a past exam into this draft (append).
   */
  async importQuestions(ctx: HttpContext) {
    const { user, scope } = await this.scope(ctx)
    const exam = await this.findExam(ctx, Number(ctx.params.id))
    if (!exam) return
    if (!this.canManage(scope, exam, user.id)) {
      return ctx.response.forbidden({ message: 'Not your exam' })
    }
    if (exam.status === 'approved' && !scope.unscoped) {
      return ctx.response.badRequest({ message: 'This exam is approved and locked.' })
    }
    const source = await Exam.query()
      .where('id', Number(ctx.request.input('sourceExamId')))
      .where('school_id', ctx.school.id)
      .first()
    if (!source) return ctx.response.notFound({ message: 'Source exam not found' })
    // Teachers can only pull from their own past exams.
    if (!scope.unscoped && source.teacherId !== user.id) {
      return ctx.response.forbidden({ message: 'You can only reuse your own past exams.' })
    }
    const src = await ExamQuestion.query()
      .where('exam_id', source.id)
      .orderBy('order_index', 'asc')
    const existing = await ExamQuestion.query().where('exam_id', exam.id).count('* as total')
    let order = Number(existing[0].$extras.total)
    for (const qq of src) {
      await ExamQuestion.create({
        examId: exam.id,
        type: qq.type,
        prompt: qq.prompt,
        options: qq.options,
        correctIndex: qq.correctIndex,
        marks: qq.marks,
        orderIndex: order++,
        topic: qq.topic,
        difficulty: qq.difficulty,
        explanation: qq.explanation,
        aiGenerated: qq.aiGenerated,
      })
    }
    return ctx.serialize({ ok: true, imported: src.length })
  }

  /** Resolve super_admin + admin user ids for the school (for review pings). */
  private async schoolAdminUserIds(schoolId: number): Promise<number[]> {
    const rows = await User.query()
      .whereHas('roleAssignments', (r) => {
        r.where('school_id', schoolId).whereIn('role', ['super_admin', 'admin'])
      })
      .select('id')
    return rows.map((u) => u.id)
  }
}
