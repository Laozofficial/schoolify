import { AssignmentSubmissionSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Assignment from '#models/assignment'
import Student from '#models/student'
import User from '#models/user'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export default class AssignmentSubmission extends AssignmentSubmissionSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare aiFlags: string[] | null

  @belongsTo(() => Assignment)
  declare assignment: BelongsTo<typeof Assignment>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => User, { foreignKey: 'gradedByUserId' })
  declare gradedBy: BelongsTo<typeof User>
}
