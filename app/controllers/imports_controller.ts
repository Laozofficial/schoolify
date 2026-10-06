import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { COLUMNS, runImport, type ImportKind } from '#services/importer'

const KINDS = ['classes', 'students', 'parents', 'staff'] as const

const importValidator = vine.compile(
  vine.object({
    rows: vine.array(vine.record(vine.string().maxLength(2000).optional())).maxLength(5000),
    dryRun: vine.boolean(),
    sendInvites: vine.boolean().optional(),
  })
)

/** Spreadsheet import. The client parses the file; we validate and apply rows. */
export default class ImportsController {
  async columns({ serialize }: HttpContext) {
    return serialize(COLUMNS)
  }

  async run({ school, params, request, response, serialize }: HttpContext) {
    const kind = params.kind as ImportKind
    if (!KINDS.includes(kind as (typeof KINDS)[number])) return response.notFound({ message: 'Unknown import type' })
    const payload = await request.validateUsing(importValidator)
    const rows = payload.rows.map((r) => {
      const clean: Record<string, string> = {}
      for (const [k, val] of Object.entries(r)) if (typeof val === 'string') clean[k] = val
      return clean
    })
    const results = await runImport(school, kind, rows, {
      dryRun: payload.dryRun,
      sendInvites: payload.sendInvites ?? false,
    })
    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      errors: results.filter((r) => r.status === 'error').length,
      creates: results.filter((r) => r.status === 'ok' && r.action === 'create').length,
      updates: results.filter((r) => r.status === 'ok' && r.action === 'update').length,
    }
    return serialize({ dryRun: payload.dryRun, summary, results })
  }
}
