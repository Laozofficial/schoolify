import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Line items are copied from fee_items at generation time so past invoices
 * stay stable even if the source structure is edited later.
 */
export default class extends BaseSchema {
  protected tableName = 'fee_invoice_items'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('invoice_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('fee_invoices')
        .onDelete('CASCADE')
      table.string('description').notNullable()
      table.bigInteger('amount_kobo').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index('invoice_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
