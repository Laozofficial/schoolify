import { PayslipSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'

export interface PayslipLine {
  kind: 'earning' | 'deduction'
  name: string
  amountKobo: number
}

export default class Payslip extends PayslipSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare lines: PayslipLine[]
}
