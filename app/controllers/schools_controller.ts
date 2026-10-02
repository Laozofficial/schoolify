import type { HttpContext } from '@adonisjs/core/http'
import School from '#models/school'
import { updateSchoolValidator } from '#validators/school'

export default class SchoolsController {
  async show({ school, serialize }: HttpContext) {
    return serialize(this.serialize(school))
  }

  async update({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(updateSchoolValidator)

    // subdomain uniqueness check (case-insensitive), if being changed
    if (payload.subdomain && payload.subdomain !== school.subdomain) {
      const collision = await School.query()
        .whereILike('subdomain', payload.subdomain)
        .whereNot('id', school.id)
        .first()
      if (collision) {
        return response.conflict({ message: 'That subdomain is already taken' })
      }
    }

    school.merge({
      name: payload.name ?? school.name,
      subdomain: payload.subdomain === undefined ? school.subdomain : payload.subdomain,
      badgeUrl: payload.badgeUrl === undefined ? school.badgeUrl : payload.badgeUrl,
      letterheadUrl:
        payload.letterheadUrl === undefined ? school.letterheadUrl : payload.letterheadUrl,
      signatureUrl:
        payload.signatureUrl === undefined ? school.signatureUrl : payload.signatureUrl,
      theme: payload.theme === undefined ? school.theme : (payload.theme as unknown as School['theme']),
    })
    await school.save()

    return serialize(this.serialize(school))
  }

  private serialize(s: School) {
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      subdomain: s.subdomain,
      badgeUrl: s.badgeUrl,
      letterheadUrl: s.letterheadUrl,
      signatureUrl: s.signatureUrl,
      theme: s.theme,
      createdAt: s.createdAt,
    }
  }
}
