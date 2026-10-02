import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'terms'

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
      table.string('session', 16).notNullable()
      table.enu('name', ['first', 'second', 'third']).notNullable()
      table.date('starts_on').notNullable()
      table.date('ends_on').notNullable()
      table.boolean('is_current').notNullable().defaultTo(false)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['school_id', 'session', 'name'])
      table.index(['school_id', 'is_current'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
