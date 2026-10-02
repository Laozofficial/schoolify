import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Term from '#models/term'
import User from '#models/user'
import Assessment from '#models/assessment'
import Score from '#models/score'
import Student from '#models/student'
import Subject from '#models/subject'
import ReportCardComment from '#models/report_card_comment'
import ReportApproval from '#models/report_approval'
import GradeScale from '#models/grade_scale'
import {
  createTermValidator,
  updateTermValidator,
  createAssessmentValidator,
  updateAssessmentValidator,
  enterScoresValidator,
  upsertReportCommentValidator,
} from '#validators/results'
import { setGradeScaleValidator, approveReportsValidator } from '#validators/grading'
import type { Role } from '#models/user_school_role'
import { teacherScope } from '#services/teacher_scope'
import {
  computeClassResults,
  gradeScaleFor,
  lookupGrade,
  type ResolvedGrade,
} from '#services/class_results'

export default class ResultsController {
  /* ---------------- Terms ---------------- */
  async listTerms({ school, serialize }: HttpContext) {
    const rows = await Term.query()
      .where('school_id', school.id)
      .orderBy('starts_on', 'desc')
    return serialize(rows.map(this.serializeTerm))
  }

  async createTerm({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createTermValidator)
    const row = await db.transaction(async (trx) => {
      if (payload.isCurrent) {
        await Term.query({ client: trx }).where('school_id', school.id).update({ is_current: false })
      }
      return Term.create(
        {
          schoolId: school.id,
          session: payload.session,
          name: payload.name,
          startsOn: DateTime.fromISO(payload.startsOn),
          endsOn: DateTime.fromISO(payload.endsOn),
          isCurrent: payload.isCurrent ?? false,
        },
        { client: trx }
      )
    })
    response.status(201)
    return serialize(this.serializeTerm(row))
  }

  async updateTerm({ school, params, request, response, serialize }: HttpContext) {
    const row = await Term.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Term not found' })
    const payload = await request.validateUsing(updateTermValidator)

    await db.transaction(async (trx) => {
      if (payload.isCurrent === true) {
        await Term.query({ client: trx })
          .where('school_id', school.id)
          .whereNot('id', row.id)
          .update({ is_current: false })
      }
      row.useTransaction(trx)
      row.merge({
        session: payload.session ?? row.session,
        name: payload.name ?? row.name,
        startsOn: payload.startsOn ? DateTime.fromISO(payload.startsOn) : row.startsOn,
        endsOn: payload.endsOn ? DateTime.fromISO(payload.endsOn) : row.endsOn,
        isCurrent: payload.isCurrent ?? row.isCurrent,
      })
      await row.save()
    })
    return serialize(this.serializeTerm(row))
  }

  async destroyTerm({ school, params, response }: HttpContext) {
    const row = await Term.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Term not found' })
    await row.delete()
    return response.noContent()
  }

  /* ---------------- Assessments ---------------- */
  async listAssessments({ school, serialize }: HttpContext) {
    const rows = await Assessment.query()
      .where('school_id', school.id)
      .orderBy('order_index', 'asc')
    return serialize(rows.map(this.serializeAssessment))
  }

  async createAssessment({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createAssessmentValidator)
    const row = await Assessment.create({
      schoolId: school.id,
      name: payload.name,
      weight: payload.weight,
      maxScore: payload.maxScore ?? 100,
      orderIndex: payload.orderIndex ?? 0,
    })
    response.status(201)
    return serialize(this.serializeAssessment(row))
  }

  async updateAssessment({ school, params, request, response, serialize }: HttpContext) {
    const row = await Assessment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Assessment not found' })
    const payload = await request.validateUsing(updateAssessmentValidator)
    row.merge(payload)
    await row.save()
    return serialize(this.serializeAssessment(row))
  }

  async destroyAssessment({ school, params, response }: HttpContext) {
    const row = await Assessment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Assessment not found' })
    await row.delete()
    return response.noContent()
  }

  /* ---------------- Grade scale ---------------- */
  async listGradeScale({ school, serialize }: HttpContext) {
    const rows = await this.gradeScaleFor(school.id)
    return serialize(rows.map((r) => this.serializeGrade(r)))
  }

  async setGradeScale({ school, request, response, serialize }: HttpContext) {
    const { scale } = await request.validateUsing(setGradeScaleValidator)
    await db.transaction(async (trx) => {
      await GradeScale.query({ client: trx }).where('school_id', school.id).delete()
      for (const [i, r] of scale.entries()) {
        await GradeScale.create(
          {
            schoolId: school.id,
            grade: r.grade,
            minPercentage: String(r.minPercentage),
            remark: r.remark,
            orderIndex: r.orderIndex ?? i,
          },
          { client: trx }
        )
      }
    })
    response.ok({ ok: true })
    const rows = await this.gradeScaleFor(school.id)
    return serialize(rows.map((r) => this.serializeGrade(r)))
  }

  /* ---------------- Score entry ---------------- */
  async scoreMatrix({ school, request, response, serialize }: HttpContext) {
    const termId = Number(request.input('termId'))
    const classId = Number(request.input('classId'))
    const subjectId = Number(request.input('subjectId'))
    if (!termId || !classId || !subjectId) {
      return response.badRequest({ message: 'termId, classId, and subjectId are required' })
    }

    const [term, assessments, students, scores] = await Promise.all([
      Term.query().where('id', termId).where('school_id', school.id).first(),
      Assessment.query().where('school_id', school.id).orderBy('order_index', 'asc'),
      Student.query()
        .where('school_id', school.id)
        .where('class_id', classId)
        .where('is_archived', false)
        .orderBy('last_name', 'asc'),
      Score.query()
        .where('term_id', termId)
        .where('subject_id', subjectId)
        .whereHas('student', (q) => q.where('class_id', classId)),
    ])
    if (!term) return response.notFound({ message: 'Term not found' })

    // Which students already have an approved report for this term -
    // their scores are locked (read-only) so an approved result can't
    // be altered underneath the parents/students who already saw it.
    const approvals = await ReportApproval.query()
      .where('term_id', termId)
      .whereIn(
        'student_id',
        students.map((s) => s.id)
      )
    const approvedIds = new Set(approvals.map((a) => a.studentId))

    const byKey = new Map<string, number>()
    for (const s of scores) byKey.set(`${s.studentId}:${s.assessmentId}`, Number(s.score))

    return serialize({
      term: this.serializeTerm(term),
      assessments: assessments.map(this.serializeAssessment),
      rows: students.map((st) => ({
        studentId: st.id,
        admissionNumber: st.admissionNumber,
        fullName: [st.firstName, st.lastName].filter(Boolean).join(' '),
        approved: approvedIds.has(st.id),
        scores: assessments.map((a) => ({
          assessmentId: a.id,
          score: byKey.get(`${st.id}:${a.id}`) ?? null,
        })),
      })),
    })
  }

  async enterScores({ school, auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const payload = await request.validateUsing(enterScoresValidator)

    const [term, assessment] = await Promise.all([
      Term.query().where('id', payload.termId).where('school_id', school.id).first(),
      Assessment.query()
        .where('id', payload.assessmentId)
        .where('school_id', school.id)
        .first(),
    ])
    if (!term) return response.notFound({ message: 'Term not found' })
    if (!assessment) return response.notFound({ message: 'Assessment not found' })

    // Teachers can only enter scores for (class, subject) pairs that appear
    // in their teaching load. `subjectId` is on the payload but the class
    // isn't - we look it up from the students being graded.
    const scope = await teacherScope(user, school.id)
    if (!scope.unscoped) {
      const students = await Student.query()
        .whereIn('id', payload.entries.map((e) => e.studentId))
        .where('school_id', school.id)
        .select('id', 'class_id')
      const classIds = new Set(
        students.map((s) => s.classId).filter((c): c is number => c != null)
      )
      for (const cid of classIds) {
        if (!scope.subjectPairs.has(`${cid}:${payload.subjectId}`)) {
          return response.forbidden({
            message:
              'You are not assigned to teach this subject in one of the students\' classes.',
          })
        }
      }
    }

    // Block edits to any student whose report for this term is already
    // approved. An approved result is final until an admin un-approves it.
    const approvedRows = await ReportApproval.query()
      .where('term_id', payload.termId)
      .whereIn(
        'student_id',
        payload.entries.map((e) => e.studentId)
      )
    if (approvedRows.length > 0) {
      return response.forbidden({
        message:
          'One or more of these students already have an approved report for this term. Ask an admin to un-approve it before editing scores.',
      })
    }

    await db.transaction(async (trx) => {
      for (const e of payload.entries) {
        if (e.score > assessment.maxScore) {
          throw new Error(
            `Score ${e.score} exceeds max ${assessment.maxScore} for ${assessment.name}`
          )
        }
        await Score.updateOrCreate(
          {
            termId: payload.termId,
            studentId: e.studentId,
            subjectId: payload.subjectId,
            assessmentId: payload.assessmentId,
          },
          { score: String(e.score), enteredByUserId: user.id },
          { client: trx }
        )
      }
    })

    return serialize({ ok: true, saved: payload.entries.length })
  }

  /* ---------------- Approvals ---------------- */
  /** GET /schools/:sid/terms/:tid/approvals - returns approved student ids. */
  async listApprovals({ school, params, serialize }: HttpContext) {
    const termId = Number(params.termId)
    const rows = await ReportApproval.query()
      .where('term_id', termId)
      .whereHas('student', (q) => q.where('school_id', school.id))
    return serialize({
      termId,
      approvals: rows.map((r) => ({
        studentId: r.studentId,
        approvedAt: r.approvedAt,
        approvedByUserId: r.approvedByUserId,
      })),
    })
  }

  /** POST /schools/:sid/approvals { termId, studentIds } - bulk approve. */
  async approve({ school, auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const payload = await request.validateUsing(approveReportsValidator)

    // guard: all students must belong to this school
    const valid = await Student.query()
      .whereIn('id', payload.studentIds)
      .where('school_id', school.id)
      .select('id')
    const ids = valid.map((s) => s.id)

    await db.transaction(async (trx) => {
      for (const sid of ids) {
        await ReportApproval.updateOrCreate(
          { termId: payload.termId, studentId: sid },
          { approvedByUserId: user.id, approvedAt: DateTime.now() },
          { client: trx }
        )
      }
    })

    response.ok({ approved: ids.length })
    return serialize({ approved: ids.length })
  }

  /**
   * GET /schools/:sid/classes/:classId/results?termId=X
   * Whole-class overview: every student × every subject with a score in the
   * term, plus overall totals + positions. Staff/teacher only.
   */
  async classResults({ school, params, request, response, serialize }: HttpContext) {
    const classId = Number(params.classId)
    const termId = Number(request.input('termId'))
    if (!termId) return response.badRequest({ message: 'termId required' })

    const data = await computeClassResults(school.id, classId, termId)
    if (!data) return response.notFound({ message: 'Term not found' })

    return serialize({
      term: this.serializeTerm(data.term),
      class: { id: data.classId, name: data.className },
      subjects: data.subjects,
      rows: data.rows.map((r) => ({
        student: {
          id: r.student.id,
          admissionNumber: r.student.admissionNumber,
          fullName: r.student.fullName,
        },
        subjects: r.subjects,
        overall: r.overall,
      })),
    })
  }

  /** DELETE /schools/:sid/terms/:tid/approvals/:studentId - unapprove one. */
  async unapprove({ school, params, response }: HttpContext) {
    const termId = Number(params.termId)
    const studentId = Number(params.studentId)
    // guard tenancy
    const student = await Student.query()
      .where('id', studentId)
      .where('school_id', school.id)
      .first()
    if (!student) return response.notFound({ message: 'Student not found' })

    await ReportApproval.query()
      .where('term_id', termId)
      .where('student_id', studentId)
      .delete()
    return response.noContent()
  }

  /* ---------------- Report card ---------------- */
  async studentReport({ school, auth, params, request, response, serialize }: HttpContext) {
    const studentId = Number(params.studentId)
    const termId = Number(request.input('termId'))
    if (!termId) return response.badRequest({ message: 'termId required' })

    const [student, term, assessments, gradeScale] = await Promise.all([
      Student.query()
        .where('id', studentId)
        .where('school_id', school.id)
        .preload('schoolClass')
        .first(),
      Term.query().where('id', termId).where('school_id', school.id).first(),
      Assessment.query().where('school_id', school.id).orderBy('order_index', 'asc'),
      this.gradeScaleFor(school.id),
    ])
    if (!student) return response.notFound({ message: 'Student not found' })
    if (!term) return response.notFound({ message: 'Term not found' })

    // Same permission check as attendance history
    const user = auth.getUserOrFail()
    const roles = await user.rolesAtSchool(school.id)
    const isStaff = roles.some((r: Role) =>
      ['super_admin', 'admin', 'teacher', 'accountant'].includes(r)
    )
    const isParent = roles.includes('parent')
    if (isParent) {
      const wards = await user.related('wards').query().where('students.id', studentId)
      if (wards.length === 0) return response.forbidden({ message: 'Not your ward' })
    }
    const isSelf = student.userId === user.id
    if (!isStaff && !isParent && !isSelf) {
      return response.forbidden({ message: 'Not allowed' })
    }

    // For non-staff (student / parent), block if report has not been approved for this student+term.
    if (!isStaff) {
      const approved = await ReportApproval.query()
        .where('term_id', termId)
        .where('student_id', studentId)
        .first()
      if (!approved) {
        return response.forbidden({
          message: 'Your report card is not yet available.',
        })
      }
    }

    // classmates for position math
    const classmates = student.classId
      ? await Student.query()
          .where('school_id', school.id)
          .where('class_id', student.classId)
          .where('is_archived', false)
          .select('id')
      : []
    const classmateIds = classmates.map((c) => c.id)

    const [studentSubjects, allScores, comments] = await Promise.all([
      Subject.query().where('school_id', school.id).orderBy('name', 'asc'),
      Score.query().where('term_id', termId).whereIn('student_id', classmateIds),
      ReportCardComment.query()
        .where('term_id', termId)
        .where('student_id', studentId)
        .first(),
    ])

    const totalWeight = assessments.reduce((sum, a) => sum + a.weight, 0) || 100
    type Perf = { studentId: number; subjectId: number; percentage: number; hasAny: boolean }
    const perf: Perf[] = []
    for (const sid of classmateIds) {
      for (const sub of studentSubjects) {
        let weighted = 0
        let hasAny = false
        for (const a of assessments) {
          const s = allScores.find(
            (x) =>
              x.studentId === sid && x.subjectId === sub.id && x.assessmentId === a.id
          )
          if (s) {
            hasAny = true
            const pct = (Number(s.score) / a.maxScore) * 100
            weighted += (pct * a.weight) / totalWeight
          }
        }
        perf.push({ studentId: sid, subjectId: sub.id, percentage: weighted, hasAny })
      }
    }

    const myPerf = perf.filter((p) => p.studentId === studentId && p.hasAny)
    const subjectBreakdown = myPerf.map((p) => {
      const subject = studentSubjects.find((s) => s.id === p.subjectId)!
      const rankRows = perf
        .filter((x) => x.subjectId === p.subjectId && x.hasAny)
        .sort((a, b) => b.percentage - a.percentage)
      const position = rankRows.findIndex((x) => x.studentId === studentId) + 1
      const assessmentScores = assessments.map((a) => {
        const s = allScores.find(
          (x) =>
            x.studentId === studentId && x.subjectId === subject.id && x.assessmentId === a.id
        )
        return {
          assessmentId: a.id,
          assessmentName: a.name,
          maxScore: a.maxScore,
          score: s ? Number(s.score) : null,
        }
      })
      const g = this.lookupGrade(p.percentage, gradeScale)
      return {
        subjectId: subject.id,
        subjectName: subject.name,
        assessmentScores,
        totalPercentage: Number(p.percentage.toFixed(2)),
        grade: g?.grade ?? null,
        remark: g?.remark ?? null,
        position,
        classSize: rankRows.length,
      }
    })

    const overallPct =
      subjectBreakdown.length > 0
        ? subjectBreakdown.reduce((sum, s) => sum + s.totalPercentage, 0) /
          subjectBreakdown.length
        : 0
    const overallGrade =
      subjectBreakdown.length > 0 ? this.lookupGrade(overallPct, gradeScale) : null

    const perStudentAvg = new Map<number, number>()
    for (const sid of classmateIds) {
      const rows = perf.filter((p) => p.studentId === sid && p.hasAny)
      if (rows.length === 0) continue
      const avg = rows.reduce((s, r) => s + r.percentage, 0) / rows.length
      perStudentAvg.set(sid, avg)
    }
    const ranking = [...perStudentAvg.entries()].sort((a, b) => b[1] - a[1])
    const overallPosition = ranking.findIndex(([sid]) => sid === studentId) + 1

    const approval = await ReportApproval.query()
      .where('term_id', termId)
      .where('student_id', studentId)
      .first()

    return serialize({
      student: {
        id: student.id,
        admissionNumber: student.admissionNumber,
        fullName: [student.firstName, student.middleName, student.lastName]
          .filter(Boolean)
          .join(' '),
        class: student.schoolClass
          ? { id: student.schoolClass.id, name: student.schoolClass.name }
          : null,
      },
      term: this.serializeTerm(term),
      assessments: assessments.map(this.serializeAssessment),
      subjects: subjectBreakdown,
      overall: {
        percentage: subjectBreakdown.length > 0 ? Number(overallPct.toFixed(2)) : null,
        grade: overallGrade?.grade ?? null,
        remark: overallGrade?.remark ?? null,
        position: overallPosition || null,
        classSize: ranking.length,
      },
      comments: comments
        ? {
            classTeacherComment: comments.classTeacherComment,
            principalComment: comments.principalComment,
          }
        : { classTeacherComment: null, principalComment: null },
      approval: approval
        ? { approvedAt: approval.approvedAt, approvedByUserId: approval.approvedByUserId }
        : null,
    })
  }

  async upsertComment({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(upsertReportCommentValidator)
    const term = await Term.query()
      .where('id', payload.termId)
      .where('school_id', school.id)
      .first()
    if (!term) return response.notFound({ message: 'Term not found' })
    const student = await Student.query()
      .where('id', payload.studentId)
      .where('school_id', school.id)
      .first()
    if (!student) return response.notFound({ message: 'Student not found' })

    const rights = await this.commentRights(auth.getUserOrFail(), school.id)
    if (payload.principalComment !== undefined && !rights.principal) {
      return response.forbidden({ message: "Only admins can write the principal's remark." })
    }
    if (
      payload.classTeacherComment !== undefined &&
      !rights.classTeacherFor(student.classId)
    ) {
      return response.forbidden({ message: 'Only the class teacher can write this remark.' })
    }

    const row = await ReportCardComment.updateOrCreate(
      { termId: payload.termId, studentId: payload.studentId },
      {
        classTeacherComment:
          payload.classTeacherComment === undefined
            ? undefined
            : payload.classTeacherComment,
        principalComment:
          payload.principalComment === undefined ? undefined : payload.principalComment,
      }
    )
    return serialize({
      id: row.id,
      termId: row.termId,
      studentId: row.studentId,
      classTeacherComment: row.classTeacherComment,
      principalComment: row.principalComment,
    })
  }

  /**
   * GET /classes/:classId/comments?termId= - every student's remarks for the
   * term, for the Comments editor.
   */
  async listComments({ school, params, request, response, serialize }: HttpContext) {
    const classId = Number(params.classId)
    const termId = Number(request.input('termId'))
    if (!termId) return response.badRequest({ message: 'termId required' })
    const students = await Student.query()
      .where('school_id', school.id)
      .where('class_id', classId)
      .where('is_archived', false)
      .select('id')
    const ids = students.map((s) => s.id)
    const rows = ids.length
      ? await ReportCardComment.query().where('term_id', termId).whereIn('student_id', ids)
      : []
    return serialize(
      rows.map((r) => ({
        studentId: r.studentId,
        classTeacherComment: r.classTeacherComment,
        principalComment: r.principalComment,
      }))
    )
  }

  /**
   * POST /report-comments/bulk { termId, items: [{ studentId,
   * classTeacherComment?, principalComment? }] } - save many remarks at once
   * (used after reviewing AI drafts). Same rights as the single upsert.
   */
  async bulkComments({ school, auth, request, response, serialize }: HttpContext) {
    const termId = Number(request.input('termId'))
    const items = request.input('items')
    if (!termId || !Array.isArray(items)) {
      return response.badRequest({ message: 'termId and items are required' })
    }
    const term = await Term.query().where('id', termId).where('school_id', school.id).first()
    if (!term) return response.notFound({ message: 'Term not found' })

    const ids = items.map((i: any) => Number(i?.studentId)).filter((n: number) => n > 0)
    const students = ids.length
      ? await Student.query().where('school_id', school.id).whereIn('id', ids)
      : []
    const byId = new Map(students.map((s) => [s.id, s]))
    const rights = await this.commentRights(auth.getUserOrFail(), school.id)

    const clean = (v: unknown) =>
      v === null ? null : v === undefined ? undefined : String(v).trim().slice(0, 2000) || null

    let saved = 0
    await db.transaction(async (trx) => {
      for (const it of items) {
        const student = byId.get(Number(it?.studentId))
        if (!student) continue
        const patch: { classTeacherComment?: string | null; principalComment?: string | null } = {}
        const ct = clean(it.classTeacherComment)
        const pc = clean(it.principalComment)
        if (ct !== undefined && rights.classTeacherFor(student.classId)) patch.classTeacherComment = ct
        if (pc !== undefined && rights.principal) patch.principalComment = pc
        if (Object.keys(patch).length === 0) continue
        await ReportCardComment.updateOrCreate(
          { termId, studentId: student.id },
          patch,
          { client: trx }
        )
        saved += 1
      }
    })
    return serialize({ saved })
  }

  /** Who may write which remark: admins both; a class teacher only theirs. */
  private async commentRights(user: User, schoolId: number) {
    const scope = await teacherScope(user, schoolId)
    return {
      principal: scope.unscoped,
      classTeacherFor: (classId: number | null) =>
        scope.unscoped || (classId !== null && scope.classTeacherOf.includes(classId)),
    }
  }

  /* ---------------- helpers ---------------- */
  private gradeScaleFor(schoolId: number): Promise<GradeScale[]> {
    return gradeScaleFor(schoolId)
  }

  private lookupGrade(pct: number, scale: GradeScale[]): ResolvedGrade {
    return lookupGrade(pct, scale)
  }

  private serializeGrade(row: GradeScale) {
    return {
      id: row.id,
      grade: row.grade,
      minPercentage: Number(row.minPercentage),
      remark: row.remark,
      orderIndex: row.orderIndex,
    }
  }

  private serializeTerm(row: Term) {
    return {
      id: row.id,
      session: row.session,
      name: row.name,
      startsOn: row.startsOn?.toISODate(),
      endsOn: row.endsOn?.toISODate(),
      isCurrent: row.isCurrent,
    }
  }

  private serializeAssessment(row: Assessment) {
    return {
      id: row.id,
      name: row.name,
      weight: row.weight,
      maxScore: row.maxScore,
      orderIndex: row.orderIndex,
    }
  }
}
