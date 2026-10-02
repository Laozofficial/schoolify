import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'payments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('school_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('schools')
        .onDelete('CASCADE')
      table
        .integer('invoice_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('fee_invoices')
        .onDelete('CASCADE')
      table
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')
      table.bigInteger('amount_kobo').notNullable()
      table
        .enu('method', ['cash', 'transfer', 'card', 'ussd', 'pos', 'other'])
        .notNullable()
        .defaultTo('transfer')
      table.string('reference').nullable()
      table.text('notes').nullable()
      table
        .integer('recorded_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('paid_at').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'paid_at'])
      table.index('invoice_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
