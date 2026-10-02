import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import TeacherSubject from '#models/teacher_subject'
import SchoolClass from '#models/school_class'
import Subject from '#models/subject'
import {
  createStaffValidator,
  updateStaffRolesValidator,
  setTeacherSubjectsValidator,
} from '#validators/staff'
import { provisionUserWithRoles } from '#services/user_provisioning'
import { dispatch } from '#services/queue'
import SendInviteJob from '#jobs/send_invite_job'

const STAFF_ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  teacher: 'Teacher',
  non_academic_staff: 'Non-academic staff',
  accountant: 'Accountant',
}

/**
 * Staff = users with any of {admin, teacher, non_academic_staff, accountant}
 * at the current school. Super-admins are excluded (they're the owner).
 */
const STAFF_ROLES = ['admin', 'teacher', 'non_academic_staff', 'accountant'] as const

export default class StaffController {
  async index({ school, serialize }: HttpContext) {
    const rows = await UserSchoolRole.query()
      .where('school_id', school.id)
      .whereIn('role', STAFF_ROLES as unknown as string[])
      .preload('user')

    const byUser = new Map<number, { user: User; roles: Role[] }>()
    for (const row of rows) {
      const entry = byUser.get(row.userId)
      if (entry) entry.roles.push(row.role)
      else byUser.set(row.userId, { user: row.user, roles: [row.role] })
    }

    return serialize(
      [...byUser.values()].map(({ user, roles }) => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        surname: user.surname,
        phone: user.phone,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
        roles,
      }))
    )
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createStaffValidator)
    const { user, tempPassword } = await provisionUserWithRoles({
      email: payload.email,
      fullName: payload.fullName,
      surname: payload.surname,
      phone: payload.phone ?? null,
      schoolId: school.id,
      roles: payload.roles,
    })

    // Fire-and-forget invite email - only send when we actually created creds.
    if (tempPassword) {
      const roleLabel = payload.roles
        .map((r) => STAFF_ROLE_LABELS[r] ?? r)
        .join(', ')
      await dispatch(SendInviteJob, {
        to: user.email,
        fullName: user.fullName,
        tempPassword,
        schoolName: school.name,
        roleLabel,
      })
    }

    response.status(201)
    return serialize({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      surname: user.surname,
      phone: user.phone,
      roles: payload.roles,
      tempPassword, // null if the user already existed
    })
  }

  async updateRoles({ school, params, request, response, serialize }: HttpContext) {
    const { roles } = await request.validateUsing(updateStaffRolesValidator)
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })

    // wipe existing staff roles at this school, then re-attach the new set
    await UserSchoolRole.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
      .whereIn('role', STAFF_ROLES as unknown as string[])
      .delete()

    for (const role of roles) {
      await UserSchoolRole.create({ userId: user.id, schoolId: school.id, role })
    }

    return serialize({ id: user.id, roles })
  }

  /**
   * GET /staff/:id/subjects
   * Returns the teacher's teaching load: which (class, subject) pairs they
   * are qualified to teach at this school.
   */
  async listSubjects({ school, params, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })
    const rows = await TeacherSubject.query()
      .where('user_id', user.id)
      .whereIn(
        'class_id',
        SchoolClass.query().select('id').where('school_id', school.id)
      )
    return serialize(
      rows.map((r) => ({ classId: r.classId, subjectId: r.subjectId }))
    )
  }

  /**
   * PUT /staff/:id/subjects
   * Replaces the teacher's entire teaching-load for this school. Rows
   * outside this school are left untouched (teacher may work at multiple
   * schools).
   */
  async setSubjects({ school, params, request, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })
    const { items } = await request.validateUsing(setTeacherSubjectsValidator)

    // Validate that every classId belongs to this school and each subject
    // is actually attached to that class. Rejects sneaky payloads that
    // would grant cross-tenant teaching rights.
    const classIds = [...new Set(items.map((i) => i.classId))]
    const classes = await SchoolClass.query()
      .where('school_id', school.id)
      .whereIn('id', classIds)
      .preload('subjects')
    if (classes.length !== classIds.length) {
      return response.badRequest({ message: 'One or more classes not in this school' })
    }
    const validPairs = new Set<string>()
    for (const c of classes) {
      for (const s of c.subjects) validPairs.add(`${c.id}:${s.id}`)
    }
    for (const it of items) {
      if (!validPairs.has(`${it.classId}:${it.subjectId}`)) {
        return response.badRequest({
          message: 'Subject not attached to class - attach it under Classes first.',
        })
      }
    }

    await db.transaction(async (trx) => {
      // Wipe this teacher's assignments *within this school only*.
      await TeacherSubject.query({ client: trx })
        .where('user_id', user.id)
        .whereIn(
          'class_id',
          SchoolClass.query({ client: trx }).select('id').where('school_id', school.id)
        )
        .delete()
      for (const it of items) {
        await TeacherSubject.create(
          { userId: user.id, classId: it.classId, subjectId: it.subjectId },
          { client: trx }
        )
      }
    })

    return serialize(items)
  }

  async destroy({ school, params, response }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })
    await UserSchoolRole.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
      .whereIn('role', STAFF_ROLES as unknown as string[])
      .delete()
    return response.noContent()
  }
}
