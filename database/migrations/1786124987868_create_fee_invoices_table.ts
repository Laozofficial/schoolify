import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'fee_invoices'

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
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')
      table
        .integer('term_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('terms')
        .onDelete('CASCADE')
      table
        .integer('fee_structure_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('fee_structures')
        .onDelete('SET NULL')

      table.string('invoice_number').notNullable()
      table.bigInteger('total_amount_kobo').notNullable()
      table
        .enu('status', ['pending', 'partial', 'paid', 'cancelled'])
        .notNullable()
        .defaultTo('pending')
      table.date('issued_on').notNullable()
      table.date('due_on').nullable()
      table.text('notes').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['school_id', 'invoice_number'])
      table.unique(['student_id', 'term_id', 'fee_structure_id'])
      table.index(['school_id', 'status'])
      table.index(['school_id', 'term_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
