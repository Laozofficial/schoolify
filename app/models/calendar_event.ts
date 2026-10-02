import { CalendarEventSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'

export const EVENT_TYPES = [
  'term_start',
  'term_end',
  'resumption',
  'holiday',
  'public_holiday',
  'pta',
  'sports',
  'excursion',
  'exam_week',
  'break',
  'mid_term_break',
  'visitation',
  'other',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export default class CalendarEvent extends CalendarEventSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
