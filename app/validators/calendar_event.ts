import vine from '@vinejs/vine'
import { EVENT_TYPES } from '#models/calendar_event'

const base = {
  title: vine.string().trim().minLength(1).maxLength(160),
  description: vine.string().trim().maxLength(2000).optional(),
  eventType: vine.enum(EVENT_TYPES),
  startsOn: vine.string().trim(),
  endsOn: vine.string().trim().optional(),
  allDay: vine.boolean().optional(),
  color: vine.string().trim().maxLength(16).optional(),
}

export const createCalendarEventValidator = vine.compile(vine.object(base))

export const updateCalendarEventValidator = vine.compile(
  vine.object({
    title: base.title.optional(),
    description: vine.string().trim().maxLength(2000).nullable().optional(),
    eventType: base.eventType.optional(),
    startsOn: base.startsOn.optional(),
    endsOn: vine.string().trim().nullable().optional(),
    allDay: base.allDay,
    color: vine.string().trim().maxLength(16).nullable().optional(),
  })
)
