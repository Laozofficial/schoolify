import { FeeInvoiceSchema } from '#database/schema'
import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import Student from '#models/student'
import Term from '#models/term'
import FeeStructure from '#models/fee_structure'
import FeeInvoiceItem from '#models/fee_invoice_item'
import Payment from '#models/payment'

export const INVOICE_STATUSES = ['pending', 'partial', 'paid', 'cancelled'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export default class FeeInvoice extends FeeInvoiceSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => Term)
  declare term: BelongsTo<typeof Term>

  @belongsTo(() => FeeStructure)
  declare feeStructure: BelongsTo<typeof FeeStructure>

  @hasMany(() => FeeInvoiceItem, { foreignKey: 'invoiceId' })
  declare items: HasMany<typeof FeeInvoiceItem>

  @hasMany(() => Payment, { foreignKey: 'invoiceId' })
  declare payments: HasMany<typeof Payment>
}
