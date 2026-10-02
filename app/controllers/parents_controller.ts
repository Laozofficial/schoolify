import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'
import Student from '#models/student'
import ParentStudent from '#models/parent_student'
import UserSchoolRole from '#models/user_school_role'
import db from '@adonisjs/lucid/services/db'
import {
  createParentValidator,
  updateParentValidator,
  parentLinkValidator,
} from '#validators/parent'
import { provisionUserWithRoles } from '#services/user_provisioning'
import { dispatch } from '#services/queue'
import SendInviteJob from '#jobs/send_invite_job'

export default class ParentsController {
  async index({ school, serialize }: HttpContext) {
    const rows = await UserSchoolRole.query()
      .where('school_id', school.id)
      .where('role', 'parent')
      .preload('user')

    const users = rows.map((r) => r.user)
    const userIds = users.map((u) => u.id)

    const links = userIds.length
      ? await ParentStudent.query()
          .whereIn('parent_user_id', userIds)
          .preload('student', (q) => q.where('school_id', school.id))
      : []

    const byParent = new Map<number, typeof links>()
    for (const link of links) {
      const list = byParent.get(link.parentUserId) ?? []
      list.push(link)
      byParent.set(link.parentUserId, list)
    }

    return serialize(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        surname: u.surname,
        phone: u.phone,
        wards:
          byParent.get(u.id)?.map((l) => ({
            id: l.student.id,
            fullName: [l.student.firstName, l.student.lastName].filter(Boolean).join(' '),
            admissionNumber: l.student.admissionNumber,
            relationship: l.relationship,
            isPrimary: l.isPrimary,
          })) ?? [],
      }))
    )
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createParentValidator)

    const result = await db.transaction(async (trx) => {
      const { user, tempPassword } = await provisionUserWithRoles({
        email: payload.email,
        fullName: payload.fullName,
        surname: payload.surname,
        phone: payload.phone ?? null,
        schoolId: school.id,
        roles: ['parent'],
      })

      if (payload.studentIds?.length) {
        const validStudents = await Student.query({ client: trx })
          .whereIn('id', payload.studentIds)
          .where('school_id', school.id)
        for (const s of validStudents) {
          await ParentStudent.updateOrCreate(
            { parentUserId: user.id, studentId: s.id },
            {},
            { client: trx }
          )
        }
      }
      return { user, tempPassword }
    })

    if (result.tempPassword) {
      await dispatch(SendInviteJob, {
        to: result.user.email,
        fullName: result.user.fullName,
        tempPassword: result.tempPassword,
        schoolName: school.name,
        roleLabel: 'Parent',
      })
    }

    response.status(201)
    return serialize({
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.fullName,
      surname: result.user.surname,
      phone: result.user.phone,
      tempPassword: result.tempPassword,
    })
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Parent not found' })
    const hasRole = await user.hasRole(school.id, 'parent')
    if (!hasRole) return response.notFound({ message: 'Parent not found' })

    const links = await ParentStudent.query()
      .where('parent_user_id', user.id)
      .preload('student', (q) => q.where('school_id', school.id))

    return serialize({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      surname: user.surname,
      phone: user.phone,
      wards: links.map((l) => ({
        id: l.student.id,
        fullName: [l.student.firstName, l.student.lastName].filter(Boolean).join(' '),
        admissionNumber: l.student.admissionNumber,
        relationship: l.relationship,
        isPrimary: l.isPrimary,
      })),
    })
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Parent not found' })
    const hasRole = await user.hasRole(school.id, 'parent')
    if (!hasRole) return response.notFound({ message: 'Parent not found' })

    const payload = await request.validateUsing(updateParentValidator)
    user.merge(payload)
    await user.save()
    return serialize({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      surname: user.surname,
      phone: user.phone,
    })
  }

  /** Attach an additional student to this parent. */
  async linkStudent({ school, params, request, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Parent not found' })
    const hasRole = await user.hasRole(school.id, 'parent')
    if (!hasRole) return response.notFound({ message: 'Parent not found' })

    const payload = await request.validateUsing(parentLinkValidator)
    const student = await Student.query()
      .where('id', payload.studentId)
      .where('school_id', school.id)
      .first()
    if (!student) return response.badRequest({ message: 'Student not in this school' })

    const link = await ParentStudent.updateOrCreate(
      { parentUserId: user.id, studentId: student.id },
      {
        relationship: payload.relationship ?? null,
        isPrimary: payload.isPrimary ?? false,
      }
    )
    return serialize({
      id: link.id,
      studentId: link.studentId,
      relationship: link.relationship,
      isPrimary: link.isPrimary,
    })
  }

  async unlinkStudent({ school, params, response }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Parent not found' })
    const hasRole = await user.hasRole(school.id, 'parent')
    if (!hasRole) return response.notFound({ message: 'Parent not found' })

    await ParentStudent.query()
      .where('parent_user_id', user.id)
      .where('student_id', params.studentId)
      .delete()
    return response.noContent()
  }
}
