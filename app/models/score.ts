import { ScoreSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Term from '#models/term'
import Student from '#models/student'
import Subject from '#models/subject'
import Assessment from '#models/assessment'

export default class Score extends ScoreSchema {
  @belongsTo(() => Term)
  declare term: BelongsTo<typeof Term>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>

  @belongsTo(() => Assessment)
  declare assessment: BelongsTo<typeof Assessment>
}
