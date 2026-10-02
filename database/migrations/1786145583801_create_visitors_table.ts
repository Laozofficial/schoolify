import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'visitors'

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

      table.string('full_name', 160).notNullable()
      table.string('phone', 40).nullable()
      table.string('id_type', 40).nullable() // NIN, driver, staff-id, other
      table.string('id_number', 60).nullable()
      table.string('purpose', 200).nullable()
      table
        .integer('host_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('checked_in_at').notNullable()
      table.timestamp('checked_out_at').nullable()
      table
        .integer('recorded_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.text('notes').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'checked_in_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
