import { AttendanceRecordSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Student from '#models/student'
import AttendanceDay from '#models/attendance_day'

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused', 'sick'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

export default class AttendanceRecord extends AttendanceRecordSchema {
  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => AttendanceDay, { foreignKey: 'attendanceDayId' })
  declare day: BelongsTo<typeof AttendanceDay>
}
