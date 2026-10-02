import { AttendanceDaySchema } from '#database/schema'
import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import User from '#models/user'
import AttendanceRecord from '#models/attendance_record'

export default class AttendanceDay extends AttendanceDaySchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>

  @belongsTo(() => User, { foreignKey: 'markedByUserId' })
  declare markedBy: BelongsTo<typeof User>

  @hasMany(() => AttendanceRecord, { foreignKey: 'attendanceDayId' })
  declare records: HasMany<typeof AttendanceRecord>
}
