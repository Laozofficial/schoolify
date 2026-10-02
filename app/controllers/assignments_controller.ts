import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Assignment from '#models/assignment'
import AssignmentSubmission from '#models/assignment_submission'
import Student from '#models/student'
import {
  createAssignmentValidator,
  updateAssignmentValidator,
  submitAssignmentValidator,
  gradeSubmissionValidator,
} from '#validators/assignment'

/**
 * Assignments:
 *  - staff (super_admin, admin, teacher) manage & grade
 *  - students see published assignments for their class + submit
 *  - parents can see their wards' submissions (read-only)
 */
export default class AssignmentsController {
  async index({ school, auth, request, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const roles = await user.rolesAtSchool(school.id)
    const isStaff = roles.some((r) => ['super_admin', 'admin', 'teacher'].includes(r))
    const classIdFilter = request.input('classId')

    const query = Assignment.query()
      .where('school_id', school.id)
      .preload('schoolClass')
      .preload('subject')
      .preload('teacher')
      .withCount('submissions')
      .orderBy('created_at', 'desc')

    if (classIdFilter) query.where('class_id', Number(classIdFilter))

    // Non-staff: only published, and only for the caller's class
    if (!isStaff) {
      query.where('published', true)
      if (roles.includes('student')) {
        const s = await Student.query()
          .where('user_id', user.id)
          .where('school_id', school.id)
          .first()
        if (s?.classId) query.where('class_id', s.classId)
        else query.whereRaw('1 = 0')
      } else if (roles.includes('parent')) {
        const wards = await user.related('wards').query().where('school_id', school.id)
        const wardClassIds = Array.from(
          new Set(wards.map((w) => w.classId).filter((v): v is number => v !== null))
        )
        if (wardClassIds.length) query.whereIn('class_id', wardClassIds)
        else query.whereRaw('1 = 0')
      }
    }

    const rows = await query
    return serialize(rows.map((r) => this.serialize(r)))
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createAssignmentValidator)
    const row = await Assignment.create({
      schoolId: school.id,
      classId: payload.classId,
      subjectId: payload.subjectId,
      teacherId: auth.getUserOrFail().id,
      title: payload.title,
      description: payload.description ?? null,
      rubric: payload.rubric ?? null,
      deadline: payload.deadline ? DateTime.fromISO(payload.deadline) : null,
      maxScore: payload.maxScore ?? 100,
      attachmentUrl: payload.attachmentUrl ?? null,
      published: payload.published ?? false,
    })
    await row.load('schoolClass')
    await row.load('subject')
    await row.load('teacher')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, auth, params, response, serialize }: HttpContext) {
    const row = await Assignment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('schoolClass')
      .preload('subject')
      .preload('teacher')
      .first()
    if (!row) return response.notFound({ message: 'Assignment not found' })

    // Attach submissions the caller is allowed to see
    const user = auth.getUserOrFail()
    const roles = await user.rolesAtSchool(school.id)
    const isStaff = roles.some((r) => ['super_admin', 'admin', 'teacher'].includes(r))

    let submissions: AssignmentSubmission[] = []
    if (isStaff) {
      submissions = await AssignmentSubmission.query()
        .where('assignment_id', row.id)
        .preload('student')
        .preload('gradedBy')
        .orderBy('submitted_at', 'desc')
    } else if (roles.includes('student')) {
      const s = await Student.query()
        .where('user_id', user.id)
        .where('school_id', school.id)
        .first()
      if (s) {
        submissions = await AssignmentSubmission.query()
          .where('assignment_id', row.id)
          .where('student_id', s.id)
          .preload('student')
      }
    } else if (roles.includes('parent')) {
      const wards = await user.related('wards').query().where('school_id', school.id)
      if (wards.length) {
        submissions = await AssignmentSubmission.query()
          .where('assignment_id', row.id)
          .whereIn(
            'student_id',
            wards.map((w) => w.id)
          )
          .preload('student')
      }
    }

    return serialize({
      ...this.serialize(row),
      // AI grade suggestions are for staff only, never students or parents.
      rubric: isStaff ? row.rubric : null,
      submissions: submissions.map((s) => this.serializeSubmission(s, isStaff)),
    })
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await Assignment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Assignment not found' })

    const payload = await request.validateUsing(updateAssignmentValidator)
    row.merge({
      title: payload.title ?? row.title,
      description: payload.description === undefined ? row.description : payload.description,
      rubric: payload.rubric === undefined ? row.rubric : payload.rubric,
      deadline:
        payload.deadline === undefined
          ? row.deadline
          : payload.deadline === null
            ? null
            : DateTime.fromISO(payload.deadline),
      maxScore: payload.maxScore ?? row.maxScore,
      attachmentUrl:
        payload.attachmentUrl === undefined ? row.attachmentUrl : payload.attachmentUrl,
      published: payload.published ?? row.published,
    })
    await row.save()
    await row.load('schoolClass')
    await row.load('subject')
    await row.load('teacher')
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await Assignment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Assignment not found' })
    await row.delete()
    return response.noContent()
  }

  /** Student submits (or re-submits if not yet graded). */
  async submit({ school, auth, params, request, response, serialize }: HttpContext) {
    const assignment = await Assignment.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .where('published', true)
      .first()
    if (!assignment) return response.notFound({ message: 'Assignment not found' })

    const user = auth.getUserOrFail()
    const student = await Student.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
      .first()
    if (!student) return response.forbidden({ message: 'Only students can submit' })
    if (student.classId !== assignment.classId) {
      return response.forbidden({ message: 'Assignment is for a different class' })
    }

    const payload = await request.validateUsing(submitAssignmentValidator)
    if (!payload.content && !payload.attachmentUrl) {
      return response.badRequest({ message: 'Submission needs content or an attachment' })
    }

    const existing = await AssignmentSubmission.query()
      .where('assignment_id', assignment.id)
      .where('student_id', student.id)
      .first()
    if (existing?.gradedAt) {
      return response.badRequest({ message: 'Already graded, cannot resubmit' })
    }

    const row = await AssignmentSubmission.updateOrCreate(
      { assignmentId: assignment.id, studentId: student.id },
      {
        content: payload.content ?? null,
        attachmentUrl: payload.attachmentUrl ?? null,
        submittedAt: DateTime.now(),
      }
    )
    await row.load('student')
    return serialize(this.serializeSubmission(row))
  }

  /** Teacher grades. */
  async grade({ school, auth, params, request, response, serialize }: HttpContext) {
    const sub = await AssignmentSubmission.query()
      .where('id', params.submissionId)
      .preload('assignment')
      .first()
    if (!sub || sub.assignment.schoolId !== school.id) {
      return response.notFound({ message: 'Submission not found' })
    }
    const payload = await request.validateUsing(gradeSubmissionValidator)
    if (payload.score > sub.assignment.maxScore) {
      return response.badRequest({
        message: `Score exceeds max ${sub.assignment.maxScore}`,
      })
    }
    sub.score = String(payload.score)
    sub.feedback = payload.feedback ?? null
    sub.gradedByUserId = auth.getUserOrFail().id
    sub.gradedAt = DateTime.now()
    await sub.save()
    await sub.load('student')
    await sub.load('gradedBy')
    return serialize(this.serializeSubmission(sub))
  }

  private serialize(row: Assignment) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      classId: row.classId,
      class: row.schoolClass ? { id: row.schoolClass.id, name: row.schoolClass.name } : null,
      subjectId: row.subjectId,
      subject: row.subject ? { id: row.subject.id, name: row.subject.name } : null,
      teacherId: row.teacherId,
      teacher: row.teacher
        ? { id: row.teacher.id, fullName: row.teacher.fullName, email: row.teacher.email }
        : null,
      deadline: row.deadline,
      maxScore: row.maxScore,
      attachmentUrl: row.attachmentUrl,
      published: row.published,
      submissionsCount: Number(row.$extras.submissions_count ?? 0),
      createdAt: row.createdAt,
    }
  }

  private serializeSubmission(row: AssignmentSubmission, includeAi = false) {
    return {
      id: row.id,
      assignmentId: row.assignmentId,
      student: row.student
        ? {
            id: row.student.id,
            fullName: [row.student.firstName, row.student.lastName].filter(Boolean).join(' '),
            admissionNumber: row.student.admissionNumber,
          }
        : null,
      content: row.content,
      attachmentUrl: row.attachmentUrl,
      submittedAt: row.submittedAt,
      score: row.score !== null && row.score !== undefined ? Number(row.score) : null,
      feedback: row.feedback,
      gradedAt: row.gradedAt,
      gradedBy: row.gradedBy
        ? { id: row.gradedBy.id, fullName: row.gradedBy.fullName, email: row.gradedBy.email }
        : null,
      ai:
        includeAi && row.aiSuggestedAt
          ? {
              score: row.aiSuggestedScore !== null ? Number(row.aiSuggestedScore) : null,
              feedback: row.aiFeedback,
              rationale: row.aiRationale,
              flags: row.aiFlags ?? [],
              suggestedAt: row.aiSuggestedAt,
            }
          : null,
    }
  }
}
