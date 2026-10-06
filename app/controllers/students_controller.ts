import type { HttpContext } from '@adonisjs/core/http'
import Student from '#models/student'
import User from '#models/user'
import ParentStudent from '#models/parent_student'
import UserSchoolRole from '#models/user_school_role'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { emitEvent } from '#services/events'
import SchoolClass from '#models/school_class'
import { createStudentValidator, updateStudentValidator } from '#validators/student'
import { provisionUserWithRoles } from '#services/user_provisioning'
import { teacherScope } from '#services/teacher_scope'

/** Extra optional profile fields, keyed to their model attribute name. */
const EXTRA_FIELDS = [
  'phone',
  'email',
  'address',
  'bloodGroup',
  'allergies',
  'previousSchool',
  'religion',
  'homeLanguage',
  'emergencyContactName',
  'emergencyContactPhone',
] as const

export default class StudentsController {
  async index({ school, auth, request, serialize }: HttpContext) {
    const archived = request.input('archived') === 'true'
    const search = String(request.input('q') ?? '').trim()

    const query = Student.query()
      .where('school_id', school.id)
      .where('is_archived', archived)
      .preload('schoolClass')
      .preload('parents')
      .orderBy('last_name', 'asc')

    // Teachers only see students in the classes they are class teacher of.
    // Admins see everyone.
    const scope = await teacherScope(auth.getUserOrFail(), school.id)
    if (!scope.unscoped) {
      const myClassIds = await SchoolClass.query()
        .where('school_id', school.id)
        .where('class_teacher_id', auth.user!.id)
        .select('id')
      const ids = myClassIds.map((c) => c.id)
      query.whereIn('class_id', ids.length ? ids : [-1])
    }

    if (search) {
      query.where((q) =>
        q
          .whereILike('first_name', `%${search}%`)
          .orWhereILike('last_name', `%${search}%`)
          .orWhereILike('admission_number', `%${search}%`)
      )
    }

    const rows = await query
    return serialize(rows.map((r) => this.serialize(r)))
  }

  /**
   * GET /schools/:sid/students/next-admission-number
   * Returns e.g. "ADM/2025/0007" - 4-digit counter per calendar year,
   * scoped to the school.
   */
  async nextAdmissionNumber({ school, serialize }: HttpContext) {
    const year = new Date().getFullYear()
    const prefix = `ADM/${year}/`
    const existing = await Student.query()
      .where('school_id', school.id)
      .whereILike('admission_number', `${prefix}%`)
      .select('admission_number')

    let max = 0
    for (const r of existing) {
      const tail = r.admissionNumber.slice(prefix.length)
      const n = parseInt(tail, 10)
      if (Number.isFinite(n) && n > max) max = n
    }
    const next = `${prefix}${String(max + 1).padStart(4, '0')}`
    return serialize({ admissionNumber: next })
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createStudentValidator)

    const student = await db.transaction(async (trx) => {
      const email = this.syntheticStudentEmail(payload.admissionNumber, school.slug)
      const { user } = await provisionUserWithRoles({
        email,
        fullName: `${payload.firstName} ${payload.lastName}`,
        surname: payload.lastName,
        schoolId: school.id,
        roles: ['student'],
      })

      const extras: Record<string, unknown> = {}
      for (const f of EXTRA_FIELDS) {
        const v = (payload as Record<string, unknown>)[f]
        if (v !== undefined) extras[f] = v ?? null
      }

      const created = await Student.create(
        {
          schoolId: school.id,
          userId: user.id,
          admissionNumber: payload.admissionNumber,
          firstName: payload.firstName,
          middleName: payload.middleName ?? null,
          lastName: payload.lastName,
          dateOfBirth: payload.dateOfBirth ? DateTime.fromISO(payload.dateOfBirth) : null,
          gender: payload.gender ?? null,
          admissionYear: payload.admissionYear ?? null,
          classId: payload.classId ?? null,
          medicalNotes: payload.medicalNotes ?? null,
          photoUrl: payload.photoUrl ?? null,
          ...extras,
        },
        { client: trx }
      )

      if (payload.parents?.length) {
        for (const p of payload.parents) {
          const parentUser = await User.find(p.parentUserId, { client: trx })
          if (!parentUser) continue
          await UserSchoolRole.updateOrCreate(
            { userId: parentUser.id, schoolId: school.id, role: 'parent' },
            {},
            { client: trx }
          )
          await ParentStudent.updateOrCreate(
            { parentUserId: parentUser.id, studentId: created.id },
            { relationship: p.relationship ?? null, isPrimary: p.isPrimary ?? false },
            { client: trx }
          )
        }
      }

      return created
    })

    await student.load('schoolClass')
    await student.load('parents')
    await emitEvent(school.id, 'student.created', {
      studentId: student.id,
      admissionNumber: student.admissionNumber,
      firstName: student.firstName,
      lastName: student.lastName,
      className: student.schoolClass?.name ?? null,
      source: 'manual',
    })
    response.status(201)
    return serialize(this.serialize(student))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await Student.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('schoolClass')
      .preload('parents')
      .preload('user')
      .first()
    if (!row) return response.notFound({ message: 'Student not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await Student.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Student not found' })

    const payload = await request.validateUsing(updateStudentValidator)
    row.merge({
      ...payload,
      dateOfBirth:
        payload.dateOfBirth === undefined
          ? row.dateOfBirth
          : payload.dateOfBirth === null
            ? null
            : DateTime.fromISO(payload.dateOfBirth),
    })
    await row.save()
    await row.load('schoolClass')
    await row.load('parents')
    return serialize(this.serialize(row))
  }

  async archive({ school, params, response, serialize }: HttpContext) {
    const row = await Student.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Student not found' })
    row.isArchived = true
    await row.save()
    return serialize(this.serialize(row))
  }

  async restore({ school, params, response, serialize }: HttpContext) {
    const row = await Student.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Student not found' })
    row.isArchived = false
    await row.save()
    return serialize(this.serialize(row))
  }

  private syntheticStudentEmail(admissionNumber: string, schoolSlug: string) {
    const safe = admissionNumber.toLowerCase().replace(/[^a-z0-9]/g, '')
    return `${safe}@students.${schoolSlug}.local`
  }

  private serialize(row: Student) {
    const extras: Record<string, unknown> = {}
    for (const f of EXTRA_FIELDS) extras[f] = (row as unknown as Record<string, unknown>)[f]

    return {
      id: row.id,
      admissionNumber: row.admissionNumber,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      fullName: [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' '),
      dateOfBirth: row.dateOfBirth,
      gender: row.gender,
      admissionYear: row.admissionYear,
      classId: row.classId,
      class: row.schoolClass ? { id: row.schoolClass.id, name: row.schoolClass.name } : null,
      medicalNotes: row.medicalNotes,
      photoUrl: row.photoUrl,
      isArchived: row.isArchived,
      ...extras,
      parents:
        row.parents?.map((p) => ({
          id: p.id,
          fullName: p.fullName,
          email: p.email,
          relationship: p.$extras.pivot_relationship,
          isPrimary: !!p.$extras.pivot_is_primary,
        })) ?? [],
      createdAt: row.createdAt,
    }
  }
}
