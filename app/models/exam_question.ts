import { ExamQuestionSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export default class ExamQuestion extends ExamQuestionSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare options: string[]
}
