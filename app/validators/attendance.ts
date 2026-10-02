import vine from '@vinejs/vine'
import { ATTENDANCE_STATUSES } from '#models/attendance_record'

export const ATTENDANCE_SESSIONS = ['morning', 'afternoon'] as const

export const markAttendanceValidator = vine.compile(
  vine.object({
    classId: vine.number().positive(),
    date: vine.string().trim(),
    session: vine.enum(ATTENDANCE_SESSIONS),
    submit: vine.boolean().optional(),
    note: vine.string().trim().maxLength(500).optional(),
    records: vine
      .array(
        vine.object({
          studentId: vine.number().positive(),
          status: vine.enum(ATTENDANCE_STATUSES),
          remark: vine.string().trim().maxLength(255).optional(),
        })
      )
      .minLength(1),
  })
)
