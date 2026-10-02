import { ExamAttemptSchema } from '#database/schema'
import { belongsTo, hasMany, column } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import Exam from '#models/exam'
import Student from '#models/student'
import ExamAnswer from '#models/exam_answer'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export default class ExamAttempt extends ExamAttemptSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare questionOrder: number[]

  @belongsTo(() => Exam)
  declare exam: BelongsTo<typeof Exam>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @hasMany(() => ExamAnswer, { foreignKey: 'attemptId' })
  declare answers: HasMany<typeof ExamAnswer>
}
