import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Visitor from '#models/visitor'
import {
  createVisitorValidator,
  checkoutVisitorValidator,
} from '#validators/operations'

export default class VisitorsController {
  async index({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = Visitor.query()
      .where('school_id', school.id)
      .preload('host')
      .orderBy('checked_in_at', 'desc')
    if (qs.status === 'open') q.whereNull('checked_out_at')
    if (qs.status === 'closed') q.whereNotNull('checked_out_at')
    if (qs.q) {
      q.where((qq) => {
        qq.whereILike('full_name', `%${qs.q}%`)
          .orWhereILike('purpose', `%${qs.q}%`)
      })
    }
    const rows = await q.limit(Math.min(Number(qs.limit ?? 100), 500))
    return serialize(rows.map(this.serialize))
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createVisitorValidator)
    const row = await Visitor.create({
      schoolId: school.id,
      fullName: payload.fullName,
      phone: payload.phone ?? null,
      idType: payload.idType ?? null,
      idNumber: payload.idNumber ?? null,
      purpose: payload.purpose ?? null,
      hostUserId: payload.hostUserId ?? null,
      checkedInAt: payload.checkedInAt
        ? DateTime.fromISO(payload.checkedInAt)
        : DateTime.now(),
      recordedByUserId: auth.user?.id ?? null,
      notes: payload.notes ?? null,
    })
    await row.load('host')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async checkout({ school, params, request, response, serialize }: HttpContext) {
    const row = await Visitor.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Visitor not found' })
    const { checkedOutAt } = await request.validateUsing(checkoutVisitorValidator)
    row.checkedOutAt = checkedOutAt ? DateTime.fromISO(checkedOutAt) : DateTime.now()
    await row.save()
    await row.load('host')
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await Visitor.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Visitor not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: Visitor) {
    return {
      id: row.id,
      fullName: row.fullName,
      phone: row.phone,
      idType: row.idType,
      idNumber: row.idNumber,
      purpose: row.purpose,
      hostUserId: row.hostUserId,
      host: row.host
        ? { id: row.host.id, fullName: row.host.fullName, email: row.host.email }
        : null,
      checkedInAt: row.checkedInAt,
      checkedOutAt: row.checkedOutAt,
      notes: row.notes,
    }
  }
}
