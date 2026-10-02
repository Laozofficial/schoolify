import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import School from '#models/school'
import type { Role } from '#models/user_school_role'
import UserSchoolRole from '#models/user_school_role'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    school: School
    schoolRoles: Role[]
  }
}

/**
 * Resolves :schoolId from the route, ensures the authenticated user has any
 * role at that school, and attaches `ctx.school` + `ctx.schoolRoles`.
 * Must be placed after auth() middleware.
 */
export default class SchoolScopeMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.getUserOrFail()
    const schoolId = Number(ctx.params.schoolId)

    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      return ctx.response.badRequest({ message: 'Invalid school id' })
    }

    const school = await School.find(schoolId)
    if (!school) {
      return ctx.response.notFound({ message: 'School not found' })
    }

    const roleRows = await UserSchoolRole.query()
      .where('user_id', user.id)
      .where('school_id', schoolId)
    if (roleRows.length === 0) {
      return ctx.response.forbidden({ message: 'You have no access to this school' })
    }

    ctx.school = school
    ctx.schoolRoles = roleRows.map((r) => r.role as Role)

    return next()
  }
}
