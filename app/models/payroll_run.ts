import { PayrollRunSchema } from '#database/schema'
import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Payslip from '#models/payslip'

export default class PayrollRun extends PayrollRunSchema {
  @hasMany(() => Payslip, { foreignKey: 'runId' })
  declare payslips: HasMany<typeof Payslip>
}
