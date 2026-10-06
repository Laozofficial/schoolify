import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Finance extras: instalment schedules on fee invoices, and income that is
 * not school fees (donations, hall rental, uniform sales, grants).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('invoice_installments', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('invoice_id').unsigned().notNullable().references('id').inTable('fee_invoices').onDelete('CASCADE')
      table.integer('position').notNullable()
      table.string('label', 80).nullable()
      table.date('due_on').notNullable()
      table.bigInteger('amount_kobo').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['invoice_id'])
      table.index(['school_id', 'due_on'])
    })

    this.schema.createTable('incomes', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('category', 40).notNullable() // donation | rental | sales | grant | event | other
      table.string('description', 255).notNullable()
      table.string('payer', 160).nullable()
      table.bigInteger('amount_kobo').notNullable()
      table.date('received_on').notNullable()
      table.string('method', 20).nullable()
      table.string('reference', 80).nullable()
      table.integer('bank_account_id').unsigned().nullable().references('id').inTable('bank_accounts').onDelete('SET NULL')
      table.text('notes').nullable()
      table.integer('recorded_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'received_on'])
    })
  }

  async down() {
    this.schema.dropTable('incomes')
    this.schema.dropTable('invoice_installments')
  }
}
