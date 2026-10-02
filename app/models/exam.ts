import { ExamSchema } from '#database/schema'
import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import Subject from '#models/subject'
import User from '#models/user'
import ExamQuestion from '#models/exam_question'
import ExamAttempt from '#models/exam_attempt'

export default class Exam extends ExamSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>

  @belongsTo(() => User, { foreignKey: 'teacherId' })
  declare teacher: BelongsTo<typeof User>

  @hasMany(() => ExamQuestion)
  declare questions: HasMany<typeof ExamQuestion>

  @hasMany(() => ExamAttempt)
  declare attempts: HasMany<typeof ExamAttempt>
}
