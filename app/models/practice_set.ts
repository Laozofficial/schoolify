import { PracticeSetSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Subject from '#models/subject'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export interface PracticeQuestion {
  type: 'mcq' | 'true_false'
  prompt: string
  options: string[]
  correctIndex: number
  explanation: string | null
  topic: string | null
}

export default class PracticeSet extends PracticeSetSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare questions: PracticeQuestion[]

  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare answers: (number | null)[]

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>
}
