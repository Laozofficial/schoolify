import { createHmac } from 'node:crypto'
import { DateTime } from 'luxon'
import env from '#start/env'

/**
 * Daily child-pickup code. A 6-digit code derived deterministically from
 * (schoolId, studentId, date) signed with the app key. It needs no storage
 * and rotates automatically at midnight (Africa/Lagos). A child may only be
 * released when the person presenting matches today's code for that student.
 */
export function pickupCodeFor(
  schoolId: number,
  studentId: number,
  date?: DateTime
): string {
  const day = (date ?? DateTime.now().setZone('Africa/Lagos')).toFormat('yyyy-LL-dd')
  const secret = env.get('APP_KEY').release()
  const mac = createHmac('sha256', secret)
    .update(`pickup:${schoolId}:${studentId}:${day}`)
    .digest('hex')
  // Take the first 6 hex chars -> integer -> 6-digit zero-padded code.
  const n = parseInt(mac.slice(0, 6), 16) % 1_000_000
  return String(n).padStart(6, '0')
}

/** Constant-time-ish check of a supplied code against today's. */
export function verifyPickupCode(
  schoolId: number,
  studentId: number,
  code: string
): boolean {
  const expected = pickupCodeFor(schoolId, studentId)
  const given = String(code ?? '').trim()
  return given.length === expected.length && given === expected
}

/**
 * QR shown in the parent portal: carries the student and today's code, so a
 * gate scan fills both in one go. It is only valid today, like the code.
 */
export function pickupQrFor(schoolId: number, studentId: number): string {
  return `SFYP.${schoolId}.${studentId}.${pickupCodeFor(schoolId, studentId)}`
}

export function parsePickupQr(raw: string): { schoolId: number; studentId: number; code: string } | null {
  const m = /^SFYP\.(\d+)\.(\d+)\.(\d{6})$/.exec(String(raw ?? '').trim())
  return m ? { schoolId: Number(m[1]), studentId: Number(m[2]), code: m[3] } : null
}
