import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Notification from '#models/notification'

export default class NotificationsController {
  /**
   * GET /account/notifications
   * Returns the current user's most recent notifications plus their
   * unread count. Not school-scoped - a user might have alerts across
   * every school they work at, but we only return this school's rows
   * for the active workspace.
   */
  async index({ auth, request, serialize }: HttpContext) {
    const user = auth.user!
    const limit = Math.min(Number(request.qs().limit ?? 30), 100)
    const schoolId = request.qs().schoolId ? Number(request.qs().schoolId) : null

    const q = Notification.query()
      .where('user_id', user.id)
      .orderBy('created_at', 'desc')
      .limit(limit)
    if (schoolId) q.where('school_id', schoolId)

    const rows = await q
    const unreadQ = Notification.query()
      .where('user_id', user.id)
      .whereNull('read_at')
    if (schoolId) unreadQ.where('school_id', schoolId)
    const unread = await unreadQ.count('* as total')

    return serialize({
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        data: n.data,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      unread: Number(unread[0].$extras.total),
    })
  }

  async markRead({ auth, params, response }: HttpContext) {
    const user = auth.user!
    const row = await Notification.query()
      .where('id', params.id)
      .where('user_id', user.id)
      .first()
    if (!row) return response.notFound({ message: 'Notification not found' })
    row.readAt = DateTime.now()
    await row.save()
    return { ok: true }
  }

  async markAllRead({ auth, request }: HttpContext) {
    const user = auth.user!
    const schoolId = request.qs().schoolId ? Number(request.qs().schoolId) : null
    const q = Notification.query().where('user_id', user.id).whereNull('read_at')
    if (schoolId) q.where('school_id', schoolId)
    await q.update({ read_at: DateTime.now().toSQL() })
    return { ok: true }
  }
}
