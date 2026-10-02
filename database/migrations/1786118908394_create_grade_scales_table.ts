import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One row per grade band (A, B, C, …) per school. Report card computes a
 * student's percentage, then looks up the highest-cutoff row they clear.
 * Defaults are seeded on first read via the controller (WAEC-aligned).
 */
export default class extends BaseSchema {
  protected tableName = 'grade_scales'

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
      table.string('grade', 4).notNullable()
      table.decimal('min_percentage', 5, 2).notNullable()
      table.string('remark', 60).notNullable()
      table.integer('order_index').notNullable().defaultTo(0)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['school_id', 'grade'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
