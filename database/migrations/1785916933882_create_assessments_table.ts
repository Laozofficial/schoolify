import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'assessments'

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
      table.integer('weight').notNullable()
      table.integer('max_score').notNullable().defaultTo(100)
      table.integer('order_index').notNullable().defaultTo(0)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['school_id', 'name'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
