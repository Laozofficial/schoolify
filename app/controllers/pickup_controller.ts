import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Student from '#models/student'
import AuthorizedPickup from '#models/authorized_pickup'
import PickupLog from '#models/pickup_log'
import { parsePickupQr, verifyPickupCode } from '#services/pickup_code'
import { familyAccess } from '#services/family_access'
import { fireAutomation } from '#services/automations'
import { notifyUsers, studentAudience } from '#services/notify'
import { TZ } from '#services/gate'

const releaseValidator = vine.compile(
  vine.object({
    studentId: vine.number().positive().optional(),
    code: vine.string().trim().maxLength(10).optional(),
    qr: vine.string().trim().maxLength(80).optional(),
    collector: vine
      .object({
        type: vine.enum(['guardian', 'authorized', 'other']),
        userId: vine.number().positive().optional(),
        authorizedId: vine.number().positive().optional(),
        name: vine.string().trim().maxLength(160).optional(),
      })
      .optional(),
    note: vine.string().trim().maxLength(300).optional(),
  })
)

const authorizedValidator = vine.compile(
  vine.object({
    fullName: vine.string().trim().minLength(2).maxLength(160),
    phone: vine.string().trim().maxLength(40).nullable().optional(),
    relationship: vine.string().trim().maxLength(60).nullable().optional(),
    photoUrl: vine.string().trim().url().maxLength(500).nullable().optional(),
    validUntil: vine.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    active: vine.boolean().optional(),
  })
)

function isCurrent(a: AuthorizedPickup) {
  if (!a.active) return false
  if (!a.validUntil) return true
  return a.validUntil.toISODate()! >= DateTime.now().setZone(TZ).toISODate()!
}

function authorizedRow(a: AuthorizedPickup) {
  return {
    id: a.id,
    studentId: a.studentId,
    fullName: a.fullName,
    phone: a.phone,
    relationship: a.relationship,
    photoUrl: a.photoUrl,
    validUntil: a.validUntil ? a.validUntil.toISODate() : null,
    active: a.active,
    current: isCurrent(a),
    createdAt: a.createdAt,
  }
}

export default class PickupController {
  /** Everyone who may collect this child, for the gate to check against. */
  async collectors({ school, params, response, serialize }: HttpContext) {
    const student = await Student.query().where('school_id', school.id).where('id', params.studentId).preload('schoolClass').first()
    if (!student) return response.notFound({ message: 'Student not found' })
    const guardians = await db
      .from('parent_students as ps')
      .join('users as u', 'u.id', 'ps.parent_user_id')
      .where('ps.student_id', student.id)
      .select('u.id', 'u.full_name', 'u.phone', 'ps.relationship', 'ps.is_primary')
    const authorized = await AuthorizedPickup.query().where('school_id', school.id).where('student_id', student.id).orderBy('full_name')
    return serialize({
      student: {
        id: student.id,
        fullName: `${student.firstName} ${student.lastName}`.trim(),
        admissionNumber: student.admissionNumber,
        className: student.schoolClass?.name ?? null,
        photoUrl: student.photoUrl,
        allergies: student.allergies,
        emergencyContactName: student.emergencyContactName,
        emergencyContactPhone: student.emergencyContactPhone,
      },
      guardians: guardians.map((g: any) => ({
        userId: g.id,
        fullName: g.full_name,
        phone: g.phone,
        relationship: g.relationship,
        isPrimary: !!g.is_primary,
      })),
      authorized: authorized.filter(isCurrent).map(authorizedRow),
    })
  }

  /**
   * Check today's code (typed, or from the parent's QR) and record the
   * outcome either way. Releasing tells the guardians who collected the
   * child and when.
   */
  async release({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(releaseValidator)
    let studentId = p.studentId
    let code = p.code
    let method: 'code' | 'qr' = 'code'
    if (p.qr) {
      const parsed = parsePickupQr(p.qr)
      if (!parsed || parsed.schoolId !== school.id) return response.unprocessableEntity({ message: 'This is not a pickup QR for this school.' })
      studentId = parsed.studentId
      code = parsed.code
      method = 'qr'
    }
    if (!studentId || !code) return response.unprocessableEntity({ message: 'Choose the child and enter the code.' })
    const student = await Student.query().where('school_id', school.id).where('id', studentId).preload('schoolClass').first()
    if (!student) return response.notFound({ message: 'Student not found' })

    const valid = verifyPickupCode(school.id, student.id, code)

    // Resolve who is collecting, so the log and the parent alert name them.
    let collectorName: string | null = p.collector?.name ?? null
    let collectorUserId: number | null = null
    let authorizedId: number | null = null
    if (p.collector?.type === 'guardian' && p.collector.userId) {
      const g = await db
        .from('parent_students as ps')
        .join('users as u', 'u.id', 'ps.parent_user_id')
        .where('ps.student_id', student.id)
        .where('u.id', p.collector.userId)
        .select('u.id', 'u.full_name', 'u.email')
        .first()
      if (g) {
        collectorUserId = g.id
        collectorName = g.full_name ?? g.email
      }
    } else if (p.collector?.type === 'authorized' && p.collector.authorizedId) {
      const a = await AuthorizedPickup.query()
        .where('school_id', school.id)
        .where('student_id', student.id)
        .where('id', p.collector.authorizedId)
        .first()
      if (a && isCurrent(a)) {
        authorizedId = a.id
        collectorName = `${a.fullName}${a.relationship ? ` (${a.relationship})` : ''}`
      }
    }

    const now = DateTime.now().setZone(TZ)
    const log = await PickupLog.create({
      schoolId: school.id,
      studentId: student.id,
      outcome: valid ? 'released' : 'refused',
      method,
      collectorType: p.collector?.type ?? null,
      collectorUserId,
      authorizedPickupId: authorizedId,
      collectorName,
      recordedByUserId: auth.user?.id ?? null,
      note: p.note ?? null,
      occurredAt: now,
      day: DateTime.fromISO(now.toISODate()!),
    })

    const name = `${student.firstName} ${student.lastName}`.trim()
    if (valid) {
      const time = now.toFormat('h:mm a')
      const by = collectorName ?? 'an approved guardian'
      const audience = await studentAudience(student.id)
      await notifyUsers(audience, {
        schoolId: school.id,
        kind: 'pickup',
        title: `${name} was collected`,
        body: `Collected at ${time} by ${by}.`,
        data: { kind: 'pickup', studentId: student.id },
      })
      await fireAutomation(school.id, 'pickup', { studentId: student.id, vars: { time, collector: by } })
    }

    return serialize({
      valid,
      method,
      student: {
        id: student.id,
        fullName: name,
        admissionNumber: student.admissionNumber,
        className: student.schoolClass?.name ?? null,
        photoUrl: student.photoUrl,
      },
      log: this.logRow(log, name, student.schoolClass?.name ?? null),
    })
  }

  async logs({ school, request, serialize }: HttpContext) {
    const day = String(request.input('date') || DateTime.now().setZone(TZ).toISODate())
    const rows = await PickupLog.query()
      .where('school_id', school.id)
      .where('day', day)
      .preload('student', (q) => q.preload('schoolClass'))
      .preload('recordedBy')
      .orderBy('occurred_at', 'desc')
      .limit(500)
    return serialize(
      rows.map((r) =>
        this.logRow(r, r.student ? `${r.student.firstName} ${r.student.lastName}`.trim() : '', r.student?.schoolClass?.name ?? null)
      )
    )
  }

  /* ---------- authorised pickup people (admin side) ---------- */

  async listAuthorized({ school, params, serialize }: HttpContext) {
    const rows = await AuthorizedPickup.query().where('school_id', school.id).where('student_id', params.studentId).orderBy('full_name')
    return serialize(rows.map(authorizedRow))
  }

  async storeAuthorized({ school, auth, params, request, response, serialize }: HttpContext) {
    const student = await Student.query().where('school_id', school.id).where('id', params.studentId).first()
    if (!student) return response.notFound({ message: 'Student not found' })
    const p = await request.validateUsing(authorizedValidator)
    const row = await AuthorizedPickup.create({
      schoolId: school.id,
      studentId: student.id,
      fullName: p.fullName,
      phone: p.phone ?? null,
      relationship: p.relationship ?? null,
      photoUrl: p.photoUrl ?? null,
      validUntil: p.validUntil ? DateTime.fromISO(p.validUntil) : null,
      active: p.active ?? true,
      addedByUserId: auth.user?.id ?? null,
    })
    response.status(201)
    return serialize(authorizedRow(row))
  }

  async updateAuthorized({ school, params, request, response, serialize }: HttpContext) {
    const row = await AuthorizedPickup.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Not found' })
    const p = await request.validateUsing(authorizedValidator)
    row.merge({
      fullName: p.fullName,
      phone: p.phone ?? null,
      relationship: p.relationship ?? null,
      photoUrl: p.photoUrl ?? null,
      validUntil: p.validUntil ? DateTime.fromISO(p.validUntil) : null,
      active: p.active ?? row.active,
    })
    await row.save()
    return serialize(authorizedRow(row))
  }

  async destroyAuthorized({ school, params, response }: HttpContext) {
    const row = await AuthorizedPickup.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Not found' })
    await row.delete()
    return response.noContent()
  }

  /* ---------- parent side (only for their own children) ---------- */

  async portalList({ school, auth, params, response, serialize }: HttpContext) {
    const access = await familyAccess(auth.getUserOrFail(), school.id)
    const id = Number(params.studentId)
    if (!access.wardIds.has(id)) return response.forbidden({ message: 'Not your child' })
    const rows = await AuthorizedPickup.query().where('school_id', school.id).where('student_id', id).orderBy('full_name')
    const history = await PickupLog.query()
      .where('school_id', school.id)
      .where('student_id', id)
      .where('outcome', 'released')
      .orderBy('occurred_at', 'desc')
      .limit(10)
    return serialize({
      authorized: rows.map(authorizedRow),
      history: history.map((h) => ({
        id: h.id,
        at: h.occurredAt,
        time: h.occurredAt.setZone(TZ).toFormat('d LLL, h:mm a'),
        collectorName: h.collectorName,
      })),
    })
  }

  async portalStore(ctx: HttpContext) {
    const access = await familyAccess(ctx.auth.getUserOrFail(), ctx.school.id)
    if (!access.wardIds.has(Number(ctx.params.studentId))) return ctx.response.forbidden({ message: 'Not your child' })
    return this.storeAuthorized(ctx)
  }

  async portalDestroy(ctx: HttpContext) {
    const access = await familyAccess(ctx.auth.getUserOrFail(), ctx.school.id)
    const row = await AuthorizedPickup.query().where('school_id', ctx.school.id).where('id', ctx.params.id).first()
    if (!row || !access.wardIds.has(row.studentId)) return ctx.response.forbidden({ message: 'Not your child' })
    await row.delete()
    return ctx.response.noContent()
  }

  private logRow(r: PickupLog, studentName: string, className: string | null) {
    return {
      id: r.id,
      studentId: r.studentId,
      studentName,
      className,
      outcome: r.outcome,
      method: r.method,
      collectorType: r.collectorType,
      collectorName: r.collectorName,
      recordedBy: r.$preloaded.recordedBy && r.recordedBy ? r.recordedBy.fullName : null,
      at: r.occurredAt,
      time: r.occurredAt.setZone(TZ).toFormat('h:mm a'),
    }
  }
}
