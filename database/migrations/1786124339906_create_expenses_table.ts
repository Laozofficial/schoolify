import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Operational spending: fuel, stationery, maintenance, purchases, exam
 * materials, etc. Amounts in kobo to avoid float issues.
 */
export default class extends BaseSchema {
  protected tableName = 'expenses'

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
        .enu('category', [
          'fuel',
          'stationery',
          'maintenance',
          'purchases',
          'exam',
          'utilities',
          'transport',
          'food',
          'other',
        ])
        .notNullable()
      table.string('description').notNullable()
      /** Naira × 100, stored as bigint since school-wide totals can exceed 21M kobo (~210k NGN). */
      table.bigInteger('amount_kobo').notNullable()
      table.date('incurred_on').notNullable()
      table.string('receipt_url').nullable()
      table.text('notes').nullable()
      table
        .integer('recorded_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'incurred_on'])
      table.index(['school_id', 'category'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
