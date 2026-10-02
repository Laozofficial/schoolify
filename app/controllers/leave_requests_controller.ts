import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import LeaveRequest from '#models/leave_request'
import UserSchoolRole from '#models/user_school_role'
import {
  createLeaveRequestValidator,
  decideLeaveRequestValidator,
} from '#validators/operations'

const APPROVER_ROLES = ['super_admin', 'admin'] as const

export default class LeaveRequestsController {
  /**
   * GET /leave
   * super_admin/admin see every request; everyone else only their own.
   * Optional ?status=pending|approved|denied.
   */
  async index({ school, auth, request, serialize }: HttpContext) {
    const user = auth.user!
    const roles = await user.rolesAtSchool(school.id)
    const isApprover = roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r))

    const qs = request.qs()
    const q = LeaveRequest.query()
      .where('school_id', school.id)
      .preload('user')
      .preload('decidedBy')
      .orderBy('created_at', 'desc')
    if (!isApprover) q.where('user_id', user.id)
    if (qs.status) q.where('status', String(qs.status))
    const rows = await q.limit(Math.min(Number(qs.limit ?? 200), 500))
    return serialize(rows.map(this.serialize))
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const user = auth.user!
    const payload = await request.validateUsing(createLeaveRequestValidator)

    // Non-admins can only file requests for themselves.
    const roles = await user.rolesAtSchool(school.id)
    const isApprover = roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r))
    const targetUserId = payload.userId && isApprover ? payload.userId : user.id

    // Target user must be affiliated with this school.
    const membership = await UserSchoolRole.query()
      .where('user_id', targetUserId)
      .where('school_id', school.id)
      .first()
    if (!membership) return response.badRequest({ message: 'User not in this school' })

    const row = await LeaveRequest.create({
      schoolId: school.id,
      userId: targetUserId,
      kind: payload.kind,
      startsOn: DateTime.fromISO(payload.startsOn),
      endsOn: DateTime.fromISO(payload.endsOn),
      reason: payload.reason ?? null,
      attachmentUrl: payload.attachmentUrl ?? null,
      status: 'pending',
    })
    await row.load('user')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async decide({ school, auth, params, request, response, serialize }: HttpContext) {
    const row = await LeaveRequest.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Request not found' })
    if (row.status !== 'pending') {
      return response.badRequest({ message: 'Already decided' })
    }
    const { status, decisionNote } = await request.validateUsing(decideLeaveRequestValidator)
    row.status = status
    row.decisionNote = decisionNote ?? null
    row.decidedByUserId = auth.user?.id ?? null
    row.decidedAt = DateTime.now()
    await row.save()
    await row.load('user')
    await row.load('decidedBy')
    return serialize(this.serialize(row))
  }

  async withdraw({ school, auth, params, response, serialize }: HttpContext) {
    const row = await LeaveRequest.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Request not found' })
    if (row.userId !== auth.user!.id) {
      return response.forbidden({ message: "Not your request" })
    }
    if (row.status !== 'pending') {
      return response.badRequest({ message: 'Already decided' })
    }
    row.status = 'withdrawn'
    await row.save()
    await row.load('user')
    return serialize(this.serialize(row))
  }

  private serialize(row: LeaveRequest) {
    return {
      id: row.id,
      userId: row.userId,
      user: row.user
        ? { id: row.user.id, fullName: row.user.fullName, email: row.user.email }
        : null,
      kind: row.kind,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      reason: row.reason,
      attachmentUrl: row.attachmentUrl,
      status: row.status,
      decisionNote: row.decisionNote,
      decidedByUserId: row.decidedByUserId,
      decidedBy: row.decidedBy
        ? {
            id: row.decidedBy.id,
            fullName: row.decidedBy.fullName,
            email: row.decidedBy.email,
          }
        : null,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    }
  }
}
