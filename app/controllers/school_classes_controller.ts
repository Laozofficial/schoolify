import type { HttpContext } from '@adonisjs/core/http'
import SchoolClass from '#models/school_class'
import { createClassValidator, updateClassValidator } from '#validators/school_class'
import { teacherScope } from '#services/teacher_scope'

export default class SchoolClassesController {
  async index({ school, auth, serialize }: HttpContext) {
    const scope = await teacherScope(auth.getUserOrFail(), school.id)
    const q = SchoolClass.query()
      .where('school_id', school.id)
      .preload('classTeacher')
      .preload('subjects')
      .withCount('students')
      .orderBy('name', 'asc')
    if (!scope.unscoped) {
      // Sentinel -1 forces "no rows" when a teacher has no assigned classes.
      q.whereIn('id', scope.classIds.length ? scope.classIds : [-1])
    }
    const rows = await q
    return serialize(rows.map(this.serialize))
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createClassValidator)
    const row = await SchoolClass.create({ ...payload, schoolId: school.id })
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await SchoolClass.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('classTeacher')
      .preload('subjects')
      .first()
    if (!row) return response.notFound({ message: 'Class not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await SchoolClass.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Class not found' })

    const payload = await request.validateUsing(updateClassValidator)
    row.merge(payload)
    await row.save()
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await SchoolClass.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Class not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: SchoolClass) {
    return {
      id: row.id,
      name: row.name,
      level: row.level,
      classTeacherId: row.classTeacherId,
      classTeacher: row.classTeacher
        ? { id: row.classTeacher.id, fullName: row.classTeacher.fullName, email: row.classTeacher.email }
        : null,
      subjects: row.subjects?.map((s) => ({ id: s.id, name: s.name, code: s.code })) ?? [],
      studentsCount: Number(row.$extras.students_count ?? 0),
      createdAt: row.createdAt,
    }
  }
}
