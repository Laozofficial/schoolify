import { ClassSchema } from '#database/schema'
import { belongsTo, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import User from '#models/user'
import Student from '#models/student'
import Subject from '#models/subject'

/**
 * "class" is a reserved word in TypeScript, so we name the model SchoolClass.
 * The underlying table is still `classes`.
 */
export default class SchoolClass extends ClassSchema {
  static table = 'classes'

  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => User, { foreignKey: 'classTeacherId' })
  declare classTeacher: BelongsTo<typeof User>

  @hasMany(() => Student, { foreignKey: 'classId' })
  declare students: HasMany<typeof Student>

  @manyToMany(() => Subject, {
    pivotTable: 'class_subjects',
    localKey: 'id',
    pivotForeignKey: 'class_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'subject_id',
  })
  declare subjects: ManyToMany<typeof Subject>
}
