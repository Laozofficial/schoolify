import { FeeItemSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import FeeStructure from '#models/fee_structure'

export default class FeeItem extends FeeItemSchema {
  @belongsTo(() => FeeStructure)
  declare feeStructure: BelongsTo<typeof FeeStructure>
}
