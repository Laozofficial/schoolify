import { ReportApprovalSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Term from '#models/term'
import Student from '#models/student'
import User from '#models/user'

export default class ReportApproval extends ReportApprovalSchema {
  @belongsTo(() => Term)
  declare term: BelongsTo<typeof Term>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => User, { foreignKey: 'approvedByUserId' })
  declare approvedBy: BelongsTo<typeof User>
}
