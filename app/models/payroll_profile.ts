import { PayrollProfileSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'
import User from '#models/user'

export interface PayItem {
  name: string
  amountKobo: number
}

export default class PayrollProfile extends PayrollProfileSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare allowances: PayItem[] | null

  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare deductions: PayItem[] | null

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>
}
