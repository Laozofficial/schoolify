import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'timetable_periods'

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
      table.string('name', 60).notNullable()
      table.string('start_time', 8).notNullable()
      table.string('end_time', 8).notNullable()
      table.integer('order_index').notNullable().defaultTo(0)
      table.boolean('is_break').notNullable().defaultTo(false)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'order_index'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
