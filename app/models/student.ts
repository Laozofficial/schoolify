import { StudentSchema } from '#database/schema'
import { belongsTo, manyToMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, ManyToMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import User from '#models/user'
import SchoolClass from '#models/school_class'

export default class Student extends StudentSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>

  @manyToMany(() => User, {
    pivotTable: 'parent_students',
    localKey: 'id',
    pivotForeignKey: 'student_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'parent_user_id',
    pivotColumns: ['relationship', 'is_primary'],
  })
  declare parents: ManyToMany<typeof User>
}
