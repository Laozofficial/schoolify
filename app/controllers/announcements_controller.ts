import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Announcement from '#models/announcement'
import {
  createAnnouncementValidator,
  updateAnnouncementValidator,
} from '#validators/announcement'
import type { Role } from '#models/user_school_role'
import {
  buildCallerContext,
  callerMatchesAnyRule,
  type CallerContext,
  type TargetRule,
} from '#services/announcement_targeting'

export default class AnnouncementsController {
  /**
   * Lists announcements the caller can see. Published only by default (pass
   * ?drafts=true to include drafts - staff-only convention on the frontend).
   *
   * Visibility precedence per announcement:
   *  - target_rules set → any rule must match the caller
   *  - target_roles set (legacy) → any role overlap
   *  - nothing set → everyone at the school
   */
  async index({ school, auth, schoolRoles, request, serialize }: HttpContext) {
    const includeUnpublished = request.input('drafts') === 'true'
    const query = Announcement.query()
      .where('school_id', school.id)
      .preload('author')
      .orderBy('pinned', 'desc')
      .orderBy('published_at', 'desc')

    if (!includeUnpublished) query.whereNotNull('published_at')

    const rows = await query

    // Staff manage announcements, so they see every row regardless of targeting.
    const isStaff = schoolRoles.some((r) =>
      (['super_admin', 'admin', 'teacher', 'non_academic_staff', 'accountant'] as const).includes(
        r as never
      )
    )
    if (isStaff) return serialize(rows.map((r) => this.serialize(r)))

    // Build the caller context lazily - only needed if we hit a targeted row.
    let ctx: CallerContext | null = null
    const visible: Announcement[] = []
    for (const row of rows) {
      const rules = (row.targetRules ?? []) as TargetRule[]
      const legacy = row.targetRoles as Role[] | null

      if ((!rules || rules.length === 0) && (!legacy || legacy.length === 0)) {
        visible.push(row)
        continue
      }
      if (rules && rules.length > 0) {
        if (!ctx) ctx = await buildCallerContext(auth.getUserOrFail(), school.id)
        if (callerMatchesAnyRule(ctx, rules)) visible.push(row)
        continue
      }
      // legacy role-only path
      if (legacy && legacy.some((r) => schoolRoles.includes(r))) visible.push(row)
    }

    return serialize(visible.map((r) => this.serialize(r)))
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const author = auth.getUserOrFail()
    const payload = await request.validateUsing(createAnnouncementValidator)

    const row = await Announcement.create({
      schoolId: school.id,
      authorUserId: author.id,
      title: payload.title,
      body: payload.body,
      targetRoles: payload.targetRoles ?? null,
      targetRules: (payload.targetRules as TargetRule[] | undefined) ?? null,
      pinned: payload.pinned ?? false,
      publishedAt: payload.publish === false ? null : DateTime.now(),
    })
    await row.load('author')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await Announcement.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('author')
      .first()
    if (!row) return response.notFound({ message: 'Announcement not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await Announcement.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Announcement not found' })

    const payload = await request.validateUsing(updateAnnouncementValidator)
    row.merge({
      title: payload.title ?? row.title,
      body: payload.body ?? row.body,
      targetRoles:
        payload.targetRoles === undefined ? row.targetRoles : payload.targetRoles,
      targetRules:
        payload.targetRules === undefined
          ? row.targetRules
          : (payload.targetRules as TargetRule[] | null),
      pinned: payload.pinned ?? row.pinned,
    })
    if (payload.publish === true && !row.publishedAt) row.publishedAt = DateTime.now()
    if (payload.publish === false) row.publishedAt = null
    await row.save()
    await row.load('author')
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await Announcement.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Announcement not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: Announcement) {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      targetRoles: row.targetRoles,
      targetRules: row.targetRules,
      pinned: row.pinned,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      author: row.author
        ? { id: row.author.id, fullName: row.author.fullName, email: row.author.email }
        : null,
    }
  }
}
