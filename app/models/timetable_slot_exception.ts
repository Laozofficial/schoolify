import { TimetableSlotExceptionSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import TimetableSlot from '#models/timetable_slot'
import Subject from '#models/subject'
import User from '#models/user'

export default class TimetableSlotException extends TimetableSlotExceptionSchema {
  static table = 'timetable_slot_exceptions'

  @belongsTo(() => TimetableSlot, { foreignKey: 'slotId' })
  declare slot: BelongsTo<typeof TimetableSlot>

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>

  @belongsTo(() => User, { foreignKey: 'teacherId' })
  declare teacher: BelongsTo<typeof User>
}
