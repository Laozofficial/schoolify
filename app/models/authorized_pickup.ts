import { AuthorizedPickupSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Student from '#models/student'

export default class AuthorizedPickup extends AuthorizedPickupSchema {
  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>
}
