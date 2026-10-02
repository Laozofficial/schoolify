import { TimetableSlotSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import TimetablePeriod from '#models/timetable_period'
import Subject from '#models/subject'
import User from '#models/user'

export default class TimetableSlot extends TimetableSlotSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>

  @belongsTo(() => TimetablePeriod, { foreignKey: 'periodId' })
  declare period: BelongsTo<typeof TimetablePeriod>

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>

  @belongsTo(() => User, { foreignKey: 'teacherId' })
  declare teacher: BelongsTo<typeof User>
}
