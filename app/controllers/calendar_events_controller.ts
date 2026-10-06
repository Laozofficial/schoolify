import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import CalendarEvent from '#models/calendar_event'
import {
  createCalendarEventValidator,
  updateCalendarEventValidator,
} from '#validators/calendar_event'

export default class CalendarEventsController {
  async index({ school, request, serialize }: HttpContext) {
    const from = request.input('from')
    const to = request.input('to')

    const query = CalendarEvent.query()
      .where('school_id', school.id)
      .orderBy('starts_on', 'asc')

    if (from) query.where('starts_on', '>=', String(from))
    if (to) query.where('starts_on', '<=', String(to))

    const rows = await query
    return serialize(rows.map(this.serialize))
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createCalendarEventValidator)
    const row = await CalendarEvent.create({
      schoolId: school.id,
      title: payload.title,
      description: payload.description ?? null,
      eventType: payload.eventType,
      startsOn: DateTime.fromISO(payload.startsOn),
      endsOn: payload.endsOn ? DateTime.fromISO(payload.endsOn) : null,
      allDay: payload.allDay ?? true,
      color: payload.color ?? null,
    })
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await CalendarEvent.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Event not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await CalendarEvent.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Event not found' })

    const payload = await request.validateUsing(updateCalendarEventValidator)
    row.merge({
      ...payload,
      startsOn: payload.startsOn === undefined ? row.startsOn : DateTime.fromISO(payload.startsOn),
      endsOn:
        payload.endsOn === undefined
          ? row.endsOn
          : payload.endsOn === null
            ? null
            : DateTime.fromISO(payload.endsOn),
    })
    await row.save()
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await CalendarEvent.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Event not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: CalendarEvent) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      eventType: row.eventType,
      startsOn: row.startsOn?.toISODate(),
      endsOn: row.endsOn?.toISODate() ?? null,
      allDay: row.allDay,
      color: row.color,
      meetingUrl: row.meetingUrl ?? null,
    }
  }
}
