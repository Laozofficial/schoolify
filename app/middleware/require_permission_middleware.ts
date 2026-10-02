import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { can, type Action, type ResourceKey } from '#services/permissions'

/**
 * Requires the authenticated user to hold a specific (resource, action)
 * permission at the current school - resolved through role defaults plus
 * per-staff overrides. Must run after auth() + schoolScope().
 *
 *   .use(middleware.requirePermission(['timetable', 'create']))
 */
export default class RequirePermissionMiddleware {
  async handle(
    ctx: HttpContext,
    next: NextFn,
    args: [ResourceKey, Action]
  ) {
    const [resource, action] = args
    const user = ctx.auth?.user
    if (!user || !ctx.school) {
      return ctx.response.unauthorized({ message: 'Not authenticated' })
    }
    const ok = await can(user, ctx.school.id, resource, action)
    if (!ok) {
      return ctx.response.forbidden({
        message: `You don't have permission to ${action} ${resource}.`,
      })
    }
    return next()
  }
}
