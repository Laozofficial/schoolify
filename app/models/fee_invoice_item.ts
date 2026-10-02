import { FeeInvoiceItemSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import FeeInvoice from '#models/fee_invoice'

export default class FeeInvoiceItem extends FeeInvoiceItemSchema {
  @belongsTo(() => FeeInvoice, { foreignKey: 'invoiceId' })
  declare invoice: BelongsTo<typeof FeeInvoice>
}
