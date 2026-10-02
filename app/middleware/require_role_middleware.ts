import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Role } from '#models/user_school_role'

/**
 * Requires the authenticated user to hold ANY of the given roles at the
 * current school. Must be placed after schoolScope() middleware.
 *
 *   .use(middleware.schoolScope())
 *   .use(middleware.requireRole(['super_admin', 'admin']))
 */
export default class RequireRoleMiddleware {
  async handle(ctx: HttpContext, next: NextFn, allowed: Role[]) {
    if (!ctx.schoolRoles) {
      return ctx.response.internalServerError({
        message: 'schoolScope middleware must run before requireRole',
      })
    }
    const ok = ctx.schoolRoles.some((r) => allowed.includes(r))
    if (!ok) {
      return ctx.response.forbidden({
        message: `Requires one of: ${allowed.join(', ')}`,
      })
    }
    return next()
  }
}
