import { ReportCardCommentSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Term from '#models/term'
import Student from '#models/student'

export default class ReportCardComment extends ReportCardCommentSchema {
  @belongsTo(() => Term)
  declare term: BelongsTo<typeof Term>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>
}
