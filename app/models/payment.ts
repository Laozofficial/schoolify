import { PaymentSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import FeeInvoice from '#models/fee_invoice'
import Student from '#models/student'
import User from '#models/user'

export const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'ussd', 'pos', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export default class Payment extends PaymentSchema {
  @belongsTo(() => FeeInvoice, { foreignKey: 'invoiceId' })
  declare invoice: BelongsTo<typeof FeeInvoice>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => User, { foreignKey: 'recordedByUserId' })
  declare recordedBy: BelongsTo<typeof User>
}
