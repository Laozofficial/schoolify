import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'bank_accounts'

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
      table.string('name', 120).notNullable()
      table.string('bank_name', 120).notNullable()
      table.string('account_number', 40).notNullable()
      table.string('account_type', 40).nullable() // current, savings, etc.
      table.bigInteger('opening_balance_kobo').notNullable().defaultTo(0)
      table.text('notes').nullable()
      table.boolean('is_active').notNullable().defaultTo(true)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
