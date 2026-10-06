import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import School from '#models/school'
import { staffTimeline, studentTimeline } from '#services/timeline'
import { MODULES, enabledModules } from '#services/modules'

const modulesValidator = vine.compile(vine.object({ modules: vine.record(vine.boolean()) }))

export default class TimelineController {
  async student({ school, params, serialize }: HttpContext) {
    return serialize(await studentTimeline(school.id, Number(params.id)))
  }

  async staff({ school, params, serialize }: HttpContext) {
    return serialize(await staffTimeline(school.id, Number(params.id)))
  }

  /** Which optional modules are on. Every signed-in member may read this (the menu needs it). */
  async modules({ school, serialize }: HttpContext) {
    const fresh = await School.findOrFail(school.id)
    return serialize({ modules: MODULES, enabled: enabledModules(fresh) })
  }

  async saveModules({ school, request, serialize }: HttpContext) {
    const { modules } = await request.validateUsing(modulesValidator)
    const fresh = await School.findOrFail(school.id)
    const clean: Record<string, boolean> = {}
    for (const m of MODULES) if (typeof modules[m.key] === 'boolean') clean[m.key] = modules[m.key]
    fresh.settings = { ...(fresh.settings ?? {}), modules: { ...(((fresh.settings ?? {}) as any).modules ?? {}), ...clean } }
    await fresh.save()
    return serialize({ modules: MODULES, enabled: enabledModules(fresh) })
  }
}
