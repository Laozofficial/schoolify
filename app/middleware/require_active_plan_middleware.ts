import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import env from '#start/env'
import { cachedStatus } from '#services/billing'

/**
 * With BILLING_ENFORCE on, a school whose trial or plan has ended can still
 * read everything and pay, but cannot change anything until it subscribes.
 */
export default class RequireActivePlanMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!env.get('BILLING_ENFORCE')) return next()
    const method = ctx.request.method()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    if (/\/billing(\/|$)/.test(ctx.request.url())) return next()
    const school = (ctx as any).school as { id: number } | undefined
    if (school && (await cachedStatus(school.id)) === 'expired') {
      return ctx.response.paymentRequired({
        message: "Your school's Schoolify plan has ended. An admin can choose a plan in Settings, Billing to carry on making changes.",
        code: 'PLAN_REQUIRED',
      })
    }
    return next()
  }
}
