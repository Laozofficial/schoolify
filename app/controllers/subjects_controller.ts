import type { HttpContext } from '@adonisjs/core/http'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Subject from '#models/subject'
import SchoolClass from '#models/school_class'
import TeacherSubject from '#models/teacher_subject'
import db from '@adonisjs/lucid/services/db'
import { createSubjectValidator, updateSubjectValidator } from '#validators/subject'
import { teacherScope } from '#services/teacher_scope'

export default class SubjectsController {
  async index({ school, auth, serialize }: HttpContext) {
    const scope = await teacherScope(auth.getUserOrFail(), school.id)
    const q = Subject.query()
      .where('school_id', school.id)
      .preload('classes')
      .orderBy('name', 'asc')
    if (!scope.unscoped) {
      // Only the subjects the teacher actually teaches (from
      // teacher_subjects). Sentinel -1 forces zero rows if none.
      const mySubjectIds = scope.subjectPairs.size
        ? Array.from(
            new Set(
              Array.from(scope.subjectPairs).map((p) => Number(p.split(':')[1]))
            )
          )
        : [-1]
      q.whereIn('id', mySubjectIds)
    }
    const rows = await q
    return serialize(rows.map(this.serialize))
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const { classIds, ...payload } = await request.validateUsing(createSubjectValidator)
    const row = await db.transaction(async (trx) => {
      const s = await Subject.create({ ...payload, schoolId: school.id }, { client: trx })
      if (classIds?.length) await this.attachToClasses(s, classIds, school.id, trx)
      return s
    })
    await row.load('classes')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await Subject.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('classes')
      .first()
    if (!row) return response.notFound({ message: 'Subject not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await Subject.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Subject not found' })

    const { classIds, ...payload } = await request.validateUsing(updateSubjectValidator)
    await db.transaction(async (trx) => {
      row.useTransaction(trx)
      row.merge(payload)
      await row.save()
      if (classIds) {
        await row.related('classes').detach(undefined, trx)
        await this.attachToClasses(row, classIds, school.id, trx)
      }
    })
    await row.load('classes')
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await Subject.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Subject not found' })
    await row.delete()
    return response.noContent()
  }

  private async attachToClasses(
    subject: Subject,
    classIds: number[],
    schoolId: number,
    trx: TransactionClientContract
  ) {
    // guard: only allow classes in the same school
    const valid = await SchoolClass.query({ client: trx })
      .whereIn('id', classIds)
      .where('school_id', schoolId)
      .select('id')
    const ids = valid.map((c) => c.id)
    if (ids.length) await subject.related('classes').attach(ids, trx)
  }

  private serialize(row: Subject) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      classes: row.classes?.map((c) => ({ id: c.id, name: c.name })) ?? [],
      createdAt: row.createdAt,
    }
  }
}
