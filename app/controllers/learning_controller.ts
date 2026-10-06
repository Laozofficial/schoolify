import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Student from '#models/student'
import Subject from '#models/subject'
import ExamAttempt from '#models/exam_attempt'
import ExamAnswer from '#models/exam_answer'
import ExamQuestion from '#models/exam_question'
import ExamTutorNote from '#models/exam_tutor_note'
import PracticeSet, { type PracticeQuestion } from '#models/practice_set'
import { aiJson, AiError } from '#services/ai'
import { generateQuestions, noEmDash } from '#services/question_generator'

/**
 * Student learning features: post-exam review with an AI tutor, weak-topic
 * analysis and AI practice sets.
 *
 * Answer keys are revealed only for exams whose results an admin has
 * PUBLISHED, so a student cannot leak answers to classmates who are still
 * sitting the same exam (even when "show score immediately" is on).
 */

const PRACTICE_DAILY_LIMIT = 10

export default class LearningController {
  private async currentStudent(ctx: HttpContext): Promise<Student | null> {
    const user = ctx.auth.getUserOrFail()
    const student = await Student.query()
      .where('school_id', ctx.school.id)
      .where('user_id', user.id)
      .where('is_archived', false)
      .preload('schoolClass')
      .first()
    if (!student) {
      ctx.response.forbidden({ message: 'Only students can use the learning tools.' })
      return null
    }
    return student
  }

  private fail(ctx: HttpContext, e: unknown) {
    if (e instanceof AiError) return ctx.response.status(e.status).send({ message: e.message })
    throw e
  }

  /** Reviewable (published) attempts with their questions + answers. */
  private async publishedAttempts(studentId: number) {
    const attempts = await ExamAttempt.query()
      .where('student_id', studentId)
      .where('status', 'submitted')
      .whereHas('exam', (e) => e.whereNotNull('results_approved_at'))
      .preload('exam', (e) => e.preload('subject'))
      .orderBy('submitted_at', 'desc')
    return attempts
  }

  /**
   * GET /learn/overview - weak topics from published exams, reviewable
   * exams, recent practice and the subjects available for practice.
   */
  async overview(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return

    const attempts = await this.publishedAttempts(student.id)
    const attemptIds = attempts.map((a) => a.id)
    const examIds = [...new Set(attempts.map((a) => a.examId))]
    const [questions, answers] = await Promise.all([
      examIds.length ? ExamQuestion.query().whereIn('exam_id', examIds) : Promise.resolve([] as ExamQuestion[]),
      attemptIds.length ? ExamAnswer.query().whereIn('attempt_id', attemptIds) : Promise.resolve([] as ExamAnswer[]),
    ])
    const answerKey = new Map(answers.map((a) => [`${a.attemptId}:${a.questionId}`, a]))
    const qByExam = new Map<number, ExamQuestion[]>()
    for (const q of questions) qByExam.set(q.examId, [...(qByExam.get(q.examId) ?? []), q])

    // Accuracy per (subject, topic). Unanswered counts as wrong.
    const stats = new Map<string, { subjectId: number; subject: string; topic: string; correct: number; total: number }>()
    for (const a of attempts) {
      const subjectName = a.exam?.subject?.name ?? 'General'
      for (const q of qByExam.get(a.examId) ?? []) {
        const topic = q.topic?.trim() || subjectName
        const key = `${a.exam.subjectId}:${topic.toLowerCase()}`
        const st = stats.get(key) ?? { subjectId: a.exam.subjectId, subject: subjectName, topic, correct: 0, total: 0 }
        st.total++
        const ans = answerKey.get(`${a.id}:${q.id}`)
        if (ans && ans.selectedIndex === q.correctIndex) st.correct++
        stats.set(key, st)
      }
    }
    const topics = [...stats.values()].map((s) => ({ ...s, accuracy: Math.round((s.correct / s.total) * 100) }))
    const weakTopics = topics
      .filter((t) => t.total >= 2 && t.accuracy < 60)
      .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total)
      .slice(0, 8)
    const strongTopics = topics
      .filter((t) => t.total >= 2 && t.accuracy >= 80)
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 5)

    const subjects = student.classId
      ? await Subject.query()
          .whereHas('classes', (c) => c.where('classes.id', student.classId!))
          .orderBy('name', 'asc')
      : []
    const recent = await PracticeSet.query()
      .where('student_id', student.id)
      .preload('subject')
      .orderBy('created_at', 'desc')
      .limit(8)
    const today = await this.practiceToday(student.id)

    return ctx.serialize({
      weakTopics,
      strongTopics,
      reviewable: attempts.map((a) => ({
        attemptId: a.id,
        examTitle: a.exam?.title,
        subject: a.exam?.subject?.name ?? null,
        score: a.score,
        totalMarks: a.totalMarks,
        submittedAt: a.submittedAt,
      })),
      subjects: subjects.map((s) => ({ id: s.id, name: s.name })),
      practice: {
        usedToday: today,
        dailyLimit: PRACTICE_DAILY_LIMIT,
        recent: recent.map((p) => this.serializeSetSummary(p)),
      },
    })
  }

  /** GET /learn/attempts/:attemptId - full review of a published exam. */
  async review(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const attempt = await ExamAttempt.query()
      .where('id', Number(ctx.params.attemptId))
      .where('student_id', student.id)
      .where('status', 'submitted')
      .preload('exam', (e) => e.preload('subject'))
      .first()
    if (!attempt) return ctx.response.notFound({ message: 'Exam attempt not found' })
    if (!attempt.exam?.resultsApprovedAt) {
      return ctx.response.forbidden({
        message: 'Answers become available once your school publishes the results for this exam.',
      })
    }

    const [questions, answers] = await Promise.all([
      ExamQuestion.query().where('exam_id', attempt.examId),
      ExamAnswer.query().where('attempt_id', attempt.id),
    ])
    const ansBy = new Map(answers.map((a) => [a.questionId, a.selectedIndex]))
    const notes = questions.length
      ? await ExamTutorNote.query().whereIn('question_id', questions.map((q) => q.id))
      : []
    const noteBy = new Map(notes.map((n) => [`${n.questionId}:${n.selectedIndex}`, n.content]))

    const qBy = new Map(questions.map((q) => [q.id, q]))
    const order = (attempt.questionOrder ?? []).filter((id) => qBy.has(id))
    for (const q of questions) if (!order.includes(q.id)) order.push(q.id)

    const items = order.map((id) => {
      const q = qBy.get(id)!
      const selected = ansBy.get(q.id) ?? null
      return {
        questionId: q.id,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        selectedIndex: selected,
        correctIndex: q.correctIndex,
        isCorrect: selected === q.correctIndex,
        marks: q.marks,
        topic: q.topic,
        explanation: q.explanation,
        tutorNote: selected === q.correctIndex ? null : (noteBy.get(`${q.id}:${selected ?? -1}`) ?? null),
      }
    })
    return ctx.serialize({
      attemptId: attempt.id,
      examTitle: attempt.exam.title,
      subject: attempt.exam.subject?.name ?? null,
      score: attempt.score,
      totalMarks: attempt.totalMarks,
      correctCount: items.filter((i) => i.isCorrect).length,
      questions: items,
    })
  }

  /**
   * POST /learn/attempts/:attemptId/questions/:questionId/explain
   * AI tutor note for a question the student got wrong. Cached per
   * (question, chosen option), so it is generated once per mistake type.
   */
  async explain(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const attempt = await ExamAttempt.query()
      .where('id', Number(ctx.params.attemptId))
      .where('student_id', student.id)
      .preload('exam', (e) => e.preload('subject'))
      .first()
    if (!attempt?.exam?.resultsApprovedAt) {
      return ctx.response.forbidden({ message: 'This exam has not been published yet.' })
    }
    const q = await ExamQuestion.query()
      .where('id', Number(ctx.params.questionId))
      .where('exam_id', attempt.examId)
      .first()
    if (!q) return ctx.response.notFound({ message: 'Question not found' })
    const ans = await ExamAnswer.query().where('attempt_id', attempt.id).where('question_id', q.id).first()
    const selected = ans?.selectedIndex ?? -1
    if (selected === q.correctIndex) {
      return ctx.serialize({ content: 'You got this one right. Well done!' })
    }

    const cached = await ExamTutorNote.query().where('question_id', q.id).where('selected_index', selected).first()
    if (cached) return ctx.serialize({ content: cached.content, cached: true })

    const system = [
      'You are a kind, encouraging tutor for a Nigerian school student reviewing a test question they got wrong.',
      'Write 3 to 5 short sentences, speaking directly to the student:',
      '1) if they chose an option, the likely misunderstanding behind that choice (without making them feel bad);',
      '2) how to work out the correct answer, step by step if it involves calculation;',
      '3) one quick tip to remember next time.',
      'Plain text only, no LaTeX or Markdown. British English. Never use em dashes.',
    ].join(' ')
    try {
      const out = await aiJson<{ explanation: string }>({
        schoolId: ctx.school.id,
        userId: ctx.auth.user!.id,
        feature: 'exam_tutor',
        system,
        user: JSON.stringify({
          subject: attempt.exam.subject?.name ?? null,
          class: student.schoolClass?.name ?? null,
          question: q.prompt,
          options: q.options,
          correctOption: q.options[q.correctIndex],
          studentChose: selected >= 0 ? q.options[selected] : null,
          teacherExplanation: q.explanation,
        }),
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['explanation'],
          properties: { explanation: { type: 'string' } },
        },
        schemaName: 'tutor_note',
        effort: 'low',
        maxTokens: 3000,
      })
      const content = noEmDash(out.explanation.trim()).slice(0, 1500)
      // Another student may have triggered the same note concurrently.
      const note = await ExamTutorNote.firstOrCreate(
        { questionId: q.id, selectedIndex: selected },
        { content }
      )
      return ctx.serialize({ content: note.content, cached: false })
    } catch (e) {
      return this.fail(ctx, e)
    }
  }

  private async practiceToday(studentId: number) {
    const r = await PracticeSet.query()
      .where('student_id', studentId)
      .where('created_at', '>=', DateTime.now().minus({ hours: 24 }).toSQL()!)
      .count('* as total')
    return Number(r[0].$extras.total)
  }

  private serializeSetSummary(p: PracticeSet) {
    const answered = p.answers.filter((a) => a !== null).length
    return {
      id: p.id,
      subject: p.subject?.name ?? null,
      topic: p.topic,
      difficulty: p.difficulty,
      questionCount: p.questions.length,
      answered,
      score: p.score,
      completed: !!p.completedAt,
      createdAt: p.createdAt,
    }
  }

  /** Questions for the client: feedback only for already-answered ones. */
  private serializeSet(p: PracticeSet) {
    return {
      ...this.serializeSetSummary(p),
      questions: p.questions.map((q, i) => {
        const sel = p.answers[i]
        return {
          index: i,
          type: q.type,
          prompt: q.prompt,
          options: q.options,
          topic: q.topic,
          selectedIndex: sel,
          ...(sel !== null
            ? { correctIndex: q.correctIndex, isCorrect: sel === q.correctIndex, explanation: q.explanation }
            : {}),
        }
      }),
    }
  }

  /** POST /learn/practice { subjectId, topic, difficulty?, count? } */
  async createPractice(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    if (!student.classId || !student.schoolClass) {
      return ctx.response.badRequest({ message: 'You are not in a class yet.' })
    }
    const subjectId = Number(ctx.request.input('subjectId'))
    const topic = String(ctx.request.input('topic') ?? '').trim().slice(0, 200)
    const difficulty = ['easy', 'medium', 'hard'].includes(ctx.request.input('difficulty'))
      ? String(ctx.request.input('difficulty'))
      : 'mixed'
    const count = Math.min(15, Math.max(3, Number(ctx.request.input('count')) || 8))
    if (!topic) return ctx.response.badRequest({ message: 'Choose a topic to practise.' })

    const subject = await Subject.query()
      .where('id', subjectId)
      .where('school_id', ctx.school.id)
      .whereHas('classes', (c) => c.where('classes.id', student.classId!))
      .first()
    if (!subject) return ctx.response.badRequest({ message: 'Pick one of your class subjects.' })

    if ((await this.practiceToday(student.id)) >= PRACTICE_DAILY_LIMIT) {
      return ctx.response.tooManyRequests({
        message: `You have made ${PRACTICE_DAILY_LIMIT} practice sets today. Come back tomorrow for more!`,
      })
    }

    try {
      const generated = await generateQuestions({
        schoolId: ctx.school.id,
        userId: ctx.auth.user!.id,
        feature: 'practice_generate',
        className: student.schoolClass.name,
        classLevel: student.schoolClass.level,
        subjectName: subject.name,
        topic,
        count,
        difficulty,
        questionType: 'mixed',
        purpose: 'practice',
      })
      const questions: PracticeQuestion[] = generated.questions.map((g) => ({
        type: g.type,
        prompt: g.prompt,
        options: g.options,
        correctIndex: g.correctIndex,
        explanation: g.explanation,
        topic: g.topic,
      }))
      const set = await PracticeSet.create({
        schoolId: ctx.school.id,
        studentId: student.id,
        subjectId: subject.id,
        topic,
        difficulty,
        questions,
        answers: questions.map(() => null),
        score: 0,
        completedAt: null,
      })
      await set.load('subject')
      return ctx.serialize(this.serializeSet(set))
    } catch (e) {
      return this.fail(ctx, e)
    }
  }

  private async ownSet(ctx: HttpContext, studentId: number) {
    const set = await PracticeSet.query()
      .where('id', Number(ctx.params.id))
      .where('student_id', studentId)
      .preload('subject')
      .first()
    if (!set) ctx.response.notFound({ message: 'Practice set not found' })
    return set
  }

  /** GET /learn/practice/:id */
  async showPractice(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const set = await this.ownSet(ctx, student.id)
    if (!set) return
    return ctx.serialize(this.serializeSet(set))
  }

  /** POST /learn/practice/:id/answer { index, selectedIndex } - instant feedback. */
  async answerPractice(ctx: HttpContext) {
    const student = await this.currentStudent(ctx)
    if (!student) return
    const set = await this.ownSet(ctx, student.id)
    if (!set) return
    const index = Number(ctx.request.input('index'))
    const selected = Number(ctx.request.input('selectedIndex'))
    const q = set.questions[index]
    if (!q) return ctx.response.badRequest({ message: 'Unknown question' })
    if (!(selected >= 0 && selected < q.options.length)) {
      return ctx.response.badRequest({ message: 'Pick one of the options' })
    }
    // First answer counts; no changing after seeing the solution.
    if (set.answers[index] === null) {
      const answers = [...set.answers]
      answers[index] = selected
      set.answers = answers
      set.score = answers.reduce<number>((t, a, i) => t + (a !== null && a === set.questions[i].correctIndex ? 1 : 0), 0)
      if (answers.every((a) => a !== null)) set.completedAt = DateTime.now()
      await set.save()
    }
    const chosen = set.answers[index]!
    return ctx.serialize({
      index,
      selectedIndex: chosen,
      correctIndex: q.correctIndex,
      isCorrect: chosen === q.correctIndex,
      explanation: q.explanation,
      score: set.score,
      answered: set.answers.filter((a) => a !== null).length,
      completed: !!set.completedAt,
    })
  }
}
