import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import ParentStudent from '#models/parent_student'
import Announcement from '#models/announcement'
import { promoteValidator } from '#validators/promotion'
import db from '@adonisjs/lucid/services/db'
import { dispatch } from '#services/queue'
import SendPromotionEmailJob from '#jobs/send_promotion_email_job'

export default class PromotionsController {
  async promote({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(promoteValidator)
    const toClassSet = payload.toClassId !== undefined
    const gradSet = payload.graduate === true
    if (toClassSet === gradSet) {
      return response.badRequest({
        message: 'Provide either toClassId or graduate: true (not both, not neither).',
      })
    }

    const fromCls = await SchoolClass.query()
      .where('id', payload.fromClassId)
      .where('school_id', school.id)
      .first()
    if (!fromCls) return response.notFound({ message: 'Source class not found' })

    let toCls: SchoolClass | null = null
    if (payload.toClassId) {
      toCls = await SchoolClass.query()
        .where('id', payload.toClassId)
        .where('school_id', school.id)
        .first()
      if (!toCls) return response.notFound({ message: 'Target class not found' })
    }

    const students = await Student.query()
      .whereIn('id', payload.studentIds)
      .where('school_id', school.id)
      .where('class_id', payload.fromClassId)
      .where('is_archived', false)

    const validIds = students.map((s) => s.id)
    if (validIds.length === 0) {
      return response.badRequest({
        message: 'None of the students belong to the source class or are already archived.',
      })
    }

    await db.transaction(async (trx) => {
      if (payload.graduate) {
        await Student.query({ client: trx })
          .whereIn('id', validIds)
          .update({ isArchived: true, classId: null })
      } else {
        await Student.query({ client: trx })
          .whereIn('id', validIds)
          .update({ classId: payload.toClassId! })
      }
    })

    // Fire notifications after the transaction so partial commits don't leak
    // "your child moved" emails when nothing actually moved.
    await this.notifyParents({
      schoolId: school.id,
      schoolName: school.name,
      students,
      fromClassName: fromCls.name,
      toClassName: toCls?.name ?? null,
      graduated: !!payload.graduate,
      authorUserId: auth.getUserOrFail().id,
    })

    return serialize({
      moved: validIds.length,
      graduated: !!payload.graduate,
      from: { id: fromCls.id, name: fromCls.name },
      to: toCls ? { id: toCls.id, name: toCls.name } : null,
      notifications: {
        emailQueued: true,
        announcementPosted: true,
      },
    })
  }

  /**
   * Emails every linked parent + posts a single school announcement targeted
   * at the affected parents' user IDs so it shows up in their in-app feed.
   */
  private async notifyParents(opts: {
    schoolId: number
    schoolName: string
    students: Student[]
    fromClassName: string
    toClassName: string | null
    graduated: boolean
    authorUserId: number
  }) {
    const studentIds = opts.students.map((s) => s.id)
    if (studentIds.length === 0) return

    const links = await ParentStudent.query()
      .whereIn('student_id', studentIds)
      .preload('parent')

    // Email each parent about their specific ward.
    const affectedParentIds = new Set<number>()
    for (const link of links) {
      if (!link.parent?.email) continue
      const stu = opts.students.find((s) => s.id === link.studentId)
      if (!stu) continue
      affectedParentIds.add(link.parent.id)
      await dispatch(SendPromotionEmailJob, {
        to: link.parent.email,
        parentName: link.parent.fullName,
        studentName: [stu.firstName, stu.lastName].filter(Boolean).join(' '),
        schoolName: opts.schoolName,
        fromClassName: opts.fromClassName,
        toClassName: opts.toClassName,
        graduated: opts.graduated,
      })
    }

    // Post one announcement targeting exactly those parent users.
    if (affectedParentIds.size > 0) {
      const title = opts.graduated
        ? `Graduation: ${opts.students.length} student(s) from ${opts.fromClassName}`
        : `Promotion: ${opts.students.length} student(s) → ${opts.toClassName}`
      const body = opts.graduated
        ? `Your ward has graduated from ${opts.schoolName}. Congratulations!`
        : `Your ward has moved from ${opts.fromClassName} to ${opts.toClassName}.`
      await Announcement.create({
        schoolId: opts.schoolId,
        authorUserId: opts.authorUserId,
        title,
        body,
        targetRoles: null,
        targetRules: [{ type: 'users', userIds: [...affectedParentIds] }],
        pinned: true,
        publishedAt: DateTime.now(),
      })
    }
  }
}
