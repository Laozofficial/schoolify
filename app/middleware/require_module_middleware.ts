import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import School from '#models/school'
import { enabledModules, type ModuleKey } from '#services/modules'

/** Refuses a route when the school has switched its module off. */
export default class RequireModuleMiddleware {
  async handle(ctx: HttpContext, next: NextFn, module: ModuleKey) {
    const school = (ctx as any).school as School | undefined
    if (school) {
      const fresh = await School.find(school.id)
      if (fresh && !enabledModules(fresh)[module]) {
        return ctx.response.forbidden({ message: 'This feature is turned off for your school. An admin can turn it on in Settings, Modules.' })
      }
    }
    return next()
  }
}
