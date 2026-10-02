import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One row per AI model call: who triggered it, for which feature, token
 * usage and latency. Drives cost visibility and per-school caps.
 */
export default class extends BaseSchema {
  protected tableName = 'ai_calls'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('school_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('schools')
        .onDelete('CASCADE')
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      // e.g. exam_generate | exam_check | report_comments
      table.string('feature', 40).notNullable()
      table.string('model', 60).notNullable()
      table.integer('prompt_tokens').notNullable().defaultTo(0)
      table.integer('completion_tokens').notNullable().defaultTo(0)
      table.integer('latency_ms').notNullable().defaultTo(0)
      // ok | error
      table.string('status', 10).notNullable().defaultTo('ok')
      table.text('error').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'created_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
