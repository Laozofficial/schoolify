import { PickupLogSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Student from '#models/student'
import User from '#models/user'

export default class PickupLog extends PickupLogSchema {
  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => User, { foreignKey: 'recordedByUserId' })
  declare recordedBy: BelongsTo<typeof User>
}
