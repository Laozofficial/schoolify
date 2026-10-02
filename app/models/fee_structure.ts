import { FeeStructureSchema } from '#database/schema'
import { belongsTo, column, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import Term from '#models/term'
import FeeItem from '#models/fee_item'

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

export default class FeeStructure extends FeeStructureSchema {
  /** Multi-class targeting; null = applies to all classes at the school. */
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare classIds: number[] | null

  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>

  @belongsTo(() => Term)
  declare term: BelongsTo<typeof Term>

  @hasMany(() => FeeItem)
  declare items: HasMany<typeof FeeItem>
}
