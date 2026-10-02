import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import UserSchoolRole from '#models/user_school_role'
import PermissionOverride from '#models/permission_override'
import {
  effectiveMatrix,
  RESOURCES,
  ACTIONS,
  RESOURCE_KEYS,
  type ResourceKey,
  type Action,
} from '#services/permissions'

const setPermissionsValidator = vine.compile(
  vine.object({
    overrides: vine.array(
      vine.object({
        resource: vine.string().trim(),
        action: vine.enum(['create', 'read', 'update', 'delete'] as const),
        // 'allow' | 'deny' set an override; null clears it (inherit role).
        effect: vine.enum(['allow', 'deny'] as const).nullable(),
      })
    ),
  })
)

export default class PermissionsController {
  /** GET /account/permissions - the caller's own effective matrix. */
  async mine({ auth, school, serialize }: HttpContext) {
    const matrix = await effectiveMatrix(auth.getUserOrFail(), school.id)
    return serialize({
      resources: RESOURCES,
      actions: ACTIONS,
      matrix,
    })
  }

  /** GET /staff/:id/permissions - target staff's matrix (admin editor). */
  async show({ school, params, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })
    const roles = await user.rolesAtSchool(school.id)
    if (roles.length === 0) {
      return response.notFound({ message: 'User not in this school' })
    }
    const matrix = await effectiveMatrix(user, school.id)
    return serialize({
      user: { id: user.id, fullName: user.fullName, email: user.email },
      roles,
      resources: RESOURCES,
      actions: ACTIONS,
      matrix,
    })
  }

  /**
   * PUT /staff/:id/permissions
   * Replaces the target user's overrides with the supplied set. Rows with
   * effect=null are treated as "clear" (delete the override so the role
   * default applies again).
   */
  async update({ school, auth, params, request, response, serialize }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) return response.notFound({ message: 'Staff not found' })
    const roles = await user.rolesAtSchool(school.id)
    if (roles.length === 0) {
      return response.notFound({ message: 'User not in this school' })
    }
    // Guard the last line of defense: you can't strip a super_admin.
    if (roles.includes('super_admin')) {
      return response.badRequest({
        message: 'Super admins always have full access and cannot be restricted.',
      })
    }

    const { overrides } = await request.validateUsing(setPermissionsValidator)
    const actor = auth.user?.id ?? null

    await db.transaction(async (trx) => {
      for (const o of overrides) {
        if (!RESOURCE_KEYS.includes(o.resource as ResourceKey)) continue
        const resource = o.resource as ResourceKey
        const action = o.action as Action

        if (o.effect === null) {
          await PermissionOverride.query({ client: trx })
            .where('user_id', user.id)
            .where('school_id', school.id)
            .where('resource', resource)
            .where('action', action)
            .delete()
        } else {
          await PermissionOverride.updateOrCreate(
            {
              userId: user.id,
              schoolId: school.id,
              resource,
              action,
            },
            { effect: o.effect, grantedByUserId: actor },
            { client: trx }
          )
        }
      }
    })

    const matrix = await effectiveMatrix(user, school.id)
    return serialize({ matrix })
  }

  /**
   * GET /permissions/staff - list every staff member with a quick summary
   * of how many custom overrides they carry, for the picker.
   */
  async staff({ school, serialize }: HttpContext) {
    const staffRoles = ['admin', 'teacher', 'non_academic_staff', 'accountant'] as const
    const rows = await UserSchoolRole.query()
      .where('school_id', school.id)
      .whereIn('role', staffRoles as unknown as string[])
      .preload('user')

    const byUser = new Map<number, { user: User; roles: string[] }>()
    for (const row of rows) {
      const entry = byUser.get(row.userId)
      if (entry) entry.roles.push(row.role)
      else byUser.set(row.userId, { user: row.user, roles: [row.role] })
    }

    const userIds = [...byUser.keys()]
    const counts = new Map<number, number>()
    if (userIds.length) {
      const ovs = await PermissionOverride.query()
        .where('school_id', school.id)
        .whereIn('user_id', userIds)
      for (const o of ovs) counts.set(o.userId, (counts.get(o.userId) ?? 0) + 1)
    }

    return serialize(
      [...byUser.values()].map(({ user, roles }) => ({
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        roles,
        overrideCount: counts.get(user.id) ?? 0,
      }))
    )
  }
}
