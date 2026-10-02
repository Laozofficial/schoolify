import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Early warning snapshot: one row per flagged student, refreshed by the
 * weekly scan. Rules decide the signals; AI only writes the explanation.
 * `signal_hash` lets a reviewed flag stay reviewed until its signals change.
 */
export default class extends BaseSchema {
  protected tableName = 'student_risk_flags'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('student_id').unsigned().notNullable().references('id').inTable('students').onDelete('CASCADE')
      table.integer('class_id').unsigned().nullable().references('id').inTable('classes').onDelete('SET NULL')
      // high | medium | low
      table.string('level', 10).notNullable()
      table.integer('score').notNullable().defaultTo(0)
      table.jsonb('signals').notNullable()
      table.string('signal_hash', 64).notNullable()
      table.text('summary').nullable()
      table.text('suggested_action').nullable()
      // open | reviewed
      table.string('status', 10).notNullable().defaultTo('open')
      table.integer('reviewed_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('reviewed_at').nullable()
      table.text('review_note').nullable()
      table.timestamp('computed_at').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['school_id', 'student_id'])
      table.index(['school_id', 'level', 'status'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
