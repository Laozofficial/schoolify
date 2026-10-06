import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import School from '#models/school'
import GateEvent from '#models/gate_event'
import Student from '#models/student'
import {
  STAFF_ROLES,
  TZ,
  badgeCode,
  distanceM,
  gateSettings,
  parseBadge,
  personForStaff,
  personForStudent,
  recordGateEvent,
  todayLagos,
  type Person,
} from '#services/gate'

const scanValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(200),
    direction: vine.enum(['auto', 'in', 'out']).optional(),
    device: vine.string().trim().maxLength(80).optional(),
  })
)
const manualValidator = vine.compile(
  vine.object({
    personType: vine.enum(['student', 'staff']),
    id: vine.number().positive(),
    direction: vine.enum(['auto', 'in', 'out']).optional(),
    note: vine.string().trim().maxLength(300).optional(),
  })
)
const selfValidator = vine.compile(
  vine.object({
    lat: vine.number().min(-90).max(90),
    lng: vine.number().min(-180).max(180),
    accuracy: vine.number().min(0).optional(),
    direction: vine.enum(['auto', 'in', 'out']).optional(),
  })
)
const settingsValidator = vine.compile(
  vine.object({
    lateAfter: vine.string().regex(/^\d{2}:\d{2}$/),
    staffGps: vine.boolean(),
    geofence: vine
      .object({
        lat: vine.number().min(-90).max(90),
        lng: vine.number().min(-180).max(180),
        radiusM: vine.number().min(50).max(5000),
      })
      .nullable()
      .optional(),
    revokeCards: vine.boolean().optional(),
  })
)

export default class GateController {
  async settings({ school, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    return serialize(gateSettings(fresh))
  }

  async saveSettings({ school, request, serialize }: HttpContext) {
    const p = await request.validateUsing(settingsValidator)
    const fresh = await School.findOrFail(school.id)
    const current = gateSettings(fresh)
    const next = {
      lateAfter: p.lateAfter,
      staffGps: p.staffGps,
      geofence: p.geofence ?? null,
      cardVersion: p.revokeCards ? current.cardVersion + 1 : current.cardVersion,
    }
    fresh.settings = { ...(fresh.settings ?? {}), gate: next }
    await fresh.save()
    return serialize(next)
  }

  /** Card data for printing: name, detail, photo and the signed code. */
  async badges({ school, request, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    const { cardVersion } = gateSettings(fresh)
    const type = request.input('type') === 'staff' ? 'staff' : 'students'
    if (type === 'students') {
      const q = Student.query().where('school_id', school.id).where('is_archived', false).preload('schoolClass').orderBy('last_name')
      const classId = Number(request.input('classId'))
      if (classId) q.where('class_id', classId)
      const rows = await q
      return serialize(
        rows.map((s) => ({
          id: s.id,
          name: `${s.firstName} ${s.lastName}`.trim(),
          detail: s.schoolClass?.name ?? null,
          sub: s.admissionNumber,
          photoUrl: s.photoUrl,
          code: badgeCode(school.id, 's', s.id, cardVersion),
        }))
      )
    }
    const staff = await db
      .from('users as u')
      .join('user_school_roles as r', 'r.user_id', 'u.id')
      .where('r.school_id', school.id)
      .whereIn('r.role', [...STAFF_ROLES])
      .groupBy('u.id', 'u.full_name', 'u.email')
      .select('u.id', 'u.full_name', 'u.email', db.raw("string_agg(r.role, ',') as roles"))
      .orderBy('u.full_name')
    return serialize(
      staff.map((u: any) => ({
        id: u.id,
        name: u.full_name ?? u.email,
        detail: String(u.roles)
          .split(',')
          .map((r: string) => r.replace(/_/g, ' '))
          .join(', '),
        sub: null,
        photoUrl: null,
        code: badgeCode(school.id, 'u', u.id, cardVersion),
      }))
    )
  }

  async scan({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(scanValidator)
    const badge = parseBadge(p.code)
    if (!badge || badge.schoolId !== school.id) {
      return response.unprocessableEntity({ message: 'This code is not a valid card for this school.' })
    }
    const fresh = await School.findOrFail(school.id)
    if (badge.version !== gateSettings(fresh).cardVersion) {
      return response.unprocessableEntity({ message: 'This card has been replaced. Print a new card for this person.' })
    }
    const person = badge.kind === 's' ? await personForStudent(school.id, badge.id) : await personForStaff(school.id, badge.id)
    if (!person) return response.notFound({ message: 'This person is no longer at the school.' })
    const res = await recordGateEvent({
      school: fresh,
      person,
      direction: p.direction ?? 'auto',
      method: 'qr',
      recordedByUserId: auth.user?.id ?? null,
      device: p.device ?? null,
    })
    return serialize(this.result(person, res))
  }

  async manual({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(manualValidator)
    const person = p.personType === 'student' ? await personForStudent(school.id, p.id) : await personForStaff(school.id, p.id)
    if (!person) return response.notFound({ message: 'Person not found' })
    const fresh = await School.findOrFail(school.id)
    const res = await recordGateEvent({
      school: fresh,
      person,
      direction: p.direction ?? 'auto',
      method: 'manual',
      recordedByUserId: auth.user?.id ?? null,
      note: p.note ?? null,
    })
    return serialize(this.result(person, res))
  }

  /** Staff check themselves in or out from their phone, inside the geofence. */
  async selfCheckin({ school, auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const p = await request.validateUsing(selfValidator)
    const fresh = await School.findOrFail(school.id)
    const settings = gateSettings(fresh)
    if (!settings.staffGps) return response.forbidden({ message: 'Phone check-in is turned off for this school.' })
    if (!settings.geofence) return response.unprocessableEntity({ message: 'The school location has not been set yet. Ask an admin.' })
    const person = await personForStaff(school.id, user.id)
    if (!person) return response.forbidden({ message: 'Only staff can check in.' })
    const d = distanceM(settings.geofence, { lat: p.lat, lng: p.lng })
    // Allow for GPS error up to 100 m on top of the fence.
    const slack = Math.min(Math.max(p.accuracy ?? 0, 0), 100)
    if (d > settings.geofence.radiusM + slack) {
      return response.unprocessableEntity({
        message: `You are about ${d < 1000 ? `${d} m` : `${(d / 1000).toFixed(1)} km`} from school. Check in when you arrive.`,
        distance: d,
      })
    }
    const res = await recordGateEvent({
      school: fresh,
      person,
      direction: p.direction ?? 'auto',
      method: 'gps',
      recordedByUserId: user.id,
      lat: p.lat,
      lng: p.lng,
      distance: d,
    })
    return serialize(this.result(person, res))
  }

  /** The signed-in staff member's own status today plus recent history. */
  async mine({ school, auth, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const fresh = await School.findOrFail(school.id)
    const settings = gateSettings(fresh)
    const events = await GateEvent.query()
      .where('school_id', school.id)
      .where('user_id', user.id)
      .where('day', '>=', DateTime.now().setZone(TZ).minus({ days: 30 }).toISODate()!)
      .orderBy('occurred_at', 'desc')
      .limit(200)
    const fresh2 = await personForStaff(school.id, user.id)
    return serialize({
      isStaff: !!fresh2,
      staffGps: settings.staffGps,
      hasFence: !!settings.geofence,
      lateAfter: settings.lateAfter,
      card: fresh2 ? badgeCode(school.id, 'u', user.id, settings.cardVersion) : null,
      events: events.map((e) => this.eventRow(e)),
    })
  }

  /** Command centre: who is in, who is late, who has not arrived. */
  async today({ school, request, serialize }: HttpContext) {
    const day = String(request.input('date') || todayLagos())
    const fresh = await School.findOrFail(school.id)
    const settings = gateSettings(fresh)
    const events = await GateEvent.query()
      .where('school_id', school.id)
      .where('day', day)
      .preload('student', (q) => q.preload('schoolClass'))
      .preload('user')
      .orderBy('occurred_at', 'asc')

    type Agg = { first: DateTime | null; last: GateEvent | null; late: boolean }
    const students = new Map<number, Agg>()
    const staff = new Map<number, Agg>()
    for (const e of events) {
      const map = e.studentId ? students : staff
      const key = (e.studentId ?? e.userId)!
      const cur = map.get(key) ?? { first: null, last: null, late: false }
      if (e.direction === 'in' && !cur.first) cur.first = e.occurredAt
      if (e.late) cur.late = true
      cur.last = e
      map.set(key, cur)
    }

    const [studentTotal] = await db.from('students').where('school_id', school.id).where('is_archived', false).count('* as n')
    const staffRows = await db
      .from('users as u')
      .join('user_school_roles as r', 'r.user_id', 'u.id')
      .where('r.school_id', school.id)
      .whereIn('r.role', [...STAFF_ROLES])
      .whereNot('r.role', 'super_admin')
      .groupBy('u.id', 'u.full_name', 'u.email')
      .select('u.id', 'u.full_name', 'u.email', db.raw("string_agg(r.role, ',') as roles"))
      .orderBy('u.full_name')

    const byClass = await db
      .from('students as s')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .where('s.school_id', school.id)
      .where('s.is_archived', false)
      .groupBy('c.id', 'c.name')
      .select('c.id', 'c.name', db.raw('array_agg(s.id) as ids'))
      .orderBy('c.name')

    const fmt = (d: DateTime | null) => (d ? d.setZone(TZ).toFormat('HH:mm') : null)
    return serialize({
      day,
      lateAfter: settings.lateAfter,
      students: {
        total: Number((studentTotal as any).n),
        arrived: students.size,
        onSite: [...students.values()].filter((a) => a.last?.direction === 'in').length,
        late: [...students.values()].filter((a) => a.late).length,
        byClass: (byClass as any[]).map((c) => {
          const ids: number[] = (c.ids ?? []).map(Number)
          return {
            classId: c.id,
            name: c.name ?? 'No class',
            total: ids.length,
            arrived: ids.filter((id) => students.has(id)).length,
            late: ids.filter((id) => students.get(id)?.late).length,
          }
        }),
      },
      staff: staffRows.map((u: any) => {
        const a = staff.get(u.id)
        return {
          userId: u.id,
          name: u.full_name ?? u.email,
          roles: String(u.roles).replace(/_/g, ' ').split(','),
          firstIn: fmt(a?.first ?? null),
          lastOut: a?.last?.direction === 'out' ? fmt(a.last.occurredAt) : null,
          onSite: a?.last?.direction === 'in',
          late: !!a?.late,
          method: a?.last?.method ?? null,
        }
      }),
      recent: events
        .slice(-40)
        .reverse()
        .map((e) => this.eventRow(e)),
    })
  }

  async events({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = GateEvent.query()
      .where('school_id', school.id)
      .preload('student', (s) => s.preload('schoolClass'))
      .preload('user')
      .preload('recordedBy')
      .orderBy('occurred_at', 'desc')
    if (qs.from) q.where('day', '>=', String(qs.from))
    if (qs.to) q.where('day', '<=', String(qs.to))
    if (qs.type === 'student' || qs.type === 'staff') q.where('person_type', qs.type)
    if (qs.studentId) q.where('student_id', Number(qs.studentId))
    if (qs.userId) q.where('user_id', Number(qs.userId))
    if (qs.late === 'true') q.where('late', true)
    const rows = await q.limit(Math.min(Number(qs.limit ?? 200), 1000))
    return serialize(rows.map((e) => this.eventRow(e)))
  }

  /** People list for manual sign-in (search box at the gate). */
  async people({ school, request, serialize }: HttpContext) {
    const term = String(request.input('q') ?? '').trim()
    if (term.length < 2) return serialize([])
    const like = `%${term}%`
    const students = await Student.query()
      .where('school_id', school.id)
      .where('is_archived', false)
      .where((w) =>
        w
          .whereRaw("concat_ws(' ', first_name, middle_name, last_name) ilike ?", [like])
          .orWhereRaw("concat_ws(' ', first_name, last_name) ilike ?", [like])
          .orWhereILike('admission_number', like)
      )
      .preload('schoolClass')
      .limit(10)
    const staff = await db
      .from('users as u')
      .join('user_school_roles as r', 'r.user_id', 'u.id')
      .where('r.school_id', school.id)
      .whereIn('r.role', [...STAFF_ROLES])
      .where((w) => w.whereILike('u.full_name', like).orWhereILike('u.email', like))
      .distinct('u.id', 'u.full_name', 'u.email')
      .limit(10)
    return serialize([
      ...students.map((s) => ({
        personType: 'student' as const,
        id: s.id,
        name: `${s.firstName} ${s.lastName}`.trim(),
        detail: [s.schoolClass?.name, s.admissionNumber].filter(Boolean).join(' · '),
        photoUrl: s.photoUrl,
      })),
      ...staff.map((u: any) => ({ personType: 'staff' as const, id: u.id, name: u.full_name ?? u.email, detail: 'Staff', photoUrl: null })),
    ])
  }

  private result(person: Person, res: Awaited<ReturnType<typeof recordGateEvent>>) {
    return {
      person,
      direction: res.direction,
      late: res.late,
      duplicate: res.duplicate,
      at: res.event.occurredAt,
      time: res.event.occurredAt.setZone(TZ).toFormat('h:mm a'),
    }
  }

  private eventRow(e: GateEvent) {
    const s = e.$preloaded.student ? e.student : null
    const u = e.$preloaded.user ? e.user : null
    return {
      id: e.id,
      personType: e.personType,
      studentId: e.studentId,
      userId: e.userId,
      name: s ? `${s.firstName} ${s.lastName}`.trim() : u ? u.fullName ?? u.email : null,
      detail: s ? s.schoolClass?.name ?? null : null,
      direction: e.direction,
      method: e.method,
      late: e.late,
      at: e.occurredAt,
      time: e.occurredAt.setZone(TZ).toFormat('h:mm a'),
      day: e.day.toISODate(),
      distanceM: e.distanceM,
      recordedBy: e.$preloaded.recordedBy && e.recordedBy ? e.recordedBy.fullName : null,
      note: e.note,
    }
  }
}
