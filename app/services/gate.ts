import { createHmac, timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'
import env from '#start/env'
import type School from '#models/school'
import GateEvent from '#models/gate_event'
import Student from '#models/student'
import User from '#models/user'
import UserSchoolRole from '#models/user_school_role'
import { fireAutomation } from '#services/automations'
import { emitEvent } from '#services/events'

/**
 * Gate sign-in/out. ID cards carry a signed code (school, person, card
 * version) so a card cannot be forged by guessing a number, and every card
 * at a school can be revoked at once by bumping the card version.
 */

export const TZ = 'Africa/Lagos'
export const STAFF_ROLES = ['super_admin', 'admin', 'teacher', 'accountant', 'non_academic_staff'] as const

export interface GateSettings {
  /** HH:mm. Arrivals after this are marked late. */
  lateAfter: string
  /** Staff may check in by GPS from their phone. */
  staffGps: boolean
  geofence: { lat: number; lng: number; radiusM: number } | null
  /** Bumping this revokes every printed card. */
  cardVersion: number
}

export function gateSettings(school: School): GateSettings {
  const g = ((school.settings ?? {}) as any).gate ?? {}
  const fence = g.geofence
  return {
    lateAfter: typeof g.lateAfter === 'string' && /^\d{2}:\d{2}$/.test(g.lateAfter) ? g.lateAfter : '07:45',
    staffGps: !!g.staffGps,
    geofence:
      fence && Number.isFinite(Number(fence.lat)) && Number.isFinite(Number(fence.lng))
        ? { lat: Number(fence.lat), lng: Number(fence.lng), radiusM: Math.max(50, Number(fence.radiusM) || 200) }
        : null,
    cardVersion: Number(g.cardVersion) || 1,
  }
}

function sign(payload: string): string {
  return createHmac('sha256', env.get('APP_KEY').release()).update(`gate:${payload}`).digest('base64url').slice(0, 10)
}

/** Code printed in the card's QR: SFY.<school>.<s|u><id>.<version>.<sig> */
export function badgeCode(schoolId: number, kind: 's' | 'u', id: number, version: number): string {
  const payload = `${schoolId}.${kind}${id}.${version}`
  return `SFY.${payload}.${sign(payload)}`
}

export function parseBadge(code: string): { schoolId: number; kind: 's' | 'u'; id: number; version: number } | null {
  const m = /^SFY\.(\d+)\.([su])(\d+)\.(\d+)\.([A-Za-z0-9_-]{10})$/.exec(code.trim())
  if (!m) return null
  const payload = `${m[1]}.${m[2]}${m[3]}.${m[4]}`
  const expected = sign(payload)
  const a = Buffer.from(expected)
  const b = Buffer.from(m[5])
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return { schoolId: Number(m[1]), kind: m[2] as 's' | 'u', id: Number(m[3]), version: Number(m[4]) }
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

export interface Person {
  type: 'student' | 'staff'
  studentId: number | null
  userId: number | null
  name: string
  photoUrl: string | null
  detail: string | null
}

export async function personForStudent(schoolId: number, id: number): Promise<Person | null> {
  const s = await Student.query().where('school_id', schoolId).where('id', id).where('is_archived', false).preload('schoolClass').first()
  if (!s) return null
  return {
    type: 'student',
    studentId: s.id,
    userId: null,
    name: `${s.firstName} ${s.lastName}`.trim(),
    photoUrl: s.photoUrl,
    detail: [s.schoolClass?.name, s.admissionNumber].filter(Boolean).join(' · '),
  }
}

export async function personForStaff(schoolId: number, userId: number): Promise<Person | null> {
  const roles = await UserSchoolRole.query().where('school_id', schoolId).where('user_id', userId).whereIn('role', [...STAFF_ROLES])
  if (!roles.length) return null
  const u = await User.find(userId)
  if (!u) return null
  return {
    type: 'staff',
    studentId: null,
    userId: u.id,
    name: u.fullName ?? u.email,
    photoUrl: null,
    detail: roles.map((r) => r.role.replace(/_/g, ' ')).join(', '),
  }
}

export interface RecordInput {
  school: School
  person: Person
  direction: 'in' | 'out' | 'auto'
  method: 'qr' | 'manual' | 'gps'
  recordedByUserId: number | null
  lat?: number | null
  lng?: number | null
  distance?: number | null
  device?: string | null
  note?: string | null
}

export interface RecordResult {
  event: GateEvent
  direction: 'in' | 'out'
  late: boolean
  duplicate: boolean
}

/**
 * Record a sign-in or sign-out. `auto` flips from the person's last event
 * today. A repeat scan within 60 seconds returns the earlier event instead
 * of creating a second one (people tap twice; cameras read twice).
 */
export async function recordGateEvent(input: RecordInput): Promise<RecordResult> {
  const now = DateTime.now().setZone(TZ)
  const day = now.toISODate()!
  const q = GateEvent.query().where('school_id', input.school.id).where('day', day).orderBy('occurred_at', 'desc')
  if (input.person.studentId) q.where('student_id', input.person.studentId)
  else q.where('user_id', input.person.userId!)
  const last = await q.first()

  if (last && now.diff(last.occurredAt.setZone(TZ), 'seconds').seconds < 60) {
    return { event: last, direction: last.direction as 'in' | 'out', late: last.late, duplicate: true }
  }

  const direction: 'in' | 'out' = input.direction === 'auto' ? (last?.direction === 'in' ? 'out' : 'in') : input.direction
  const settings = gateSettings(input.school)
  const firstArrival = direction === 'in' && !(await hasArrivedToday(input.school.id, input.person, day))
  const late = firstArrival && now.toFormat('HH:mm') > settings.lateAfter

  const event = await GateEvent.create({
    schoolId: input.school.id,
    personType: input.person.type,
    studentId: input.person.studentId,
    userId: input.person.userId,
    direction,
    method: input.method,
    occurredAt: now,
    day: DateTime.fromISO(day),
    late,
    recordedByUserId: input.recordedByUserId,
    lat: input.lat != null ? String(input.lat) : null,
    lng: input.lng != null ? String(input.lng) : null,
    distanceM: input.distance ?? null,
    device: input.device?.slice(0, 80) ?? null,
    note: input.note?.slice(0, 300) ?? null,
  })

  await emitEvent(input.school.id, direction === 'in' ? 'gate.in' : 'gate.out', {
    personType: input.person.type,
    studentId: input.person.studentId,
    userId: input.person.userId,
    name: input.person.name,
    late,
    method: input.method,
    at: now.toISO(),
  })
  if (input.person.studentId) {
    await fireAutomation(input.school.id, direction === 'in' ? 'gate_arrival' : 'gate_departure', {
      studentId: input.person.studentId,
      vars: { time: now.toFormat('h:mm a') },
      dedupeKey: `gate:${direction}:${day}:${input.person.studentId}`,
    })
  }
  return { event, direction, late, duplicate: false }
}

async function hasArrivedToday(schoolId: number, person: Person, day: string) {
  const q = GateEvent.query().where('school_id', schoolId).where('day', day).where('direction', 'in')
  if (person.studentId) q.where('student_id', person.studentId)
  else q.where('user_id', person.userId!)
  return !!(await q.first())
}

export function todayLagos(): string {
  return DateTime.now().setZone(TZ).toISODate()!
}
