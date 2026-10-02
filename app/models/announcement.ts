import { AnnouncementSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import User from '#models/user'
import type { TargetRule } from '#services/announcement_targeting'

/**
 * `pg` treats a raw JS array as a Postgres array literal, which fails on jsonb
 * columns - so we stringify on insert. On read, pg has already parsed jsonb
 * for us (or given us a string when it can't infer), so `consume` handles both.
 */
function jsonbPrepare(v: unknown) {
  if (v === null || v === undefined) return v
  return JSON.stringify(v)
}
function jsonbConsume(v: unknown) {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

export default class Announcement extends AnnouncementSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare targetRules: TargetRule[] | null

  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare targetRoles: string[] | null

  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => User, { foreignKey: 'authorUserId' })
  declare author: BelongsTo<typeof User>
}
