import type { HttpContext } from '@adonisjs/core/http'
import UserSchoolRole from '#models/user_school_role'
import School from '#models/school'

export default class MeController {
  /**
   * Returns all schools this user has any role at, with the roles they hold at
   * each. Used by the frontend right after login to pick the active tenant.
   */
  async schools({ auth, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const rows = await UserSchoolRole.query().where('user_id', user.id)

    const byId = new Map<number, string[]>()
    for (const row of rows) {
      const list = byId.get(row.schoolId) ?? []
      list.push(row.role)
      byId.set(row.schoolId, list)
    }

    const schoolIds = [...byId.keys()]
    if (schoolIds.length === 0) return serialize([])

    const schools = await School.query().whereIn('id', schoolIds)

    return serialize(
      schools.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        subdomain: s.subdomain,
        theme: s.theme,
        badgeUrl: s.badgeUrl,
        roles: byId.get(s.id) ?? [],
      }))
    )
  }
}
