import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'fee_items'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('fee_structure_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('fee_structures')
        .onDelete('CASCADE')
      table.string('description').notNullable()
      /** kobo (int); stored as bigint so a large fee (~200k NGN → 20M kobo) fits. */
      table.bigInteger('amount_kobo').notNullable()
      table.boolean('is_optional').notNullable().defaultTo(false)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
