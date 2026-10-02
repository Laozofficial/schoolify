import { SubjectSchema } from '#database/schema'
import { belongsTo, manyToMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, ManyToMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import SchoolClass from '#models/school_class'

export default class Subject extends SubjectSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @manyToMany(() => SchoolClass, {
    pivotTable: 'class_subjects',
    localKey: 'id',
    pivotForeignKey: 'subject_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'class_id',
  })
  declare classes: ManyToMany<typeof SchoolClass>
}
