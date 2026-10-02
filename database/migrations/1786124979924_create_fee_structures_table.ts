import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'fee_structures'

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
      table.string('name').notNullable()
      /** null = applies to any class */
      table
        .integer('class_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('classes')
        .onDelete('CASCADE')
      /** null = template, must be scoped to term at invoice-generation time */
      table
        .integer('term_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('terms')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index('school_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
