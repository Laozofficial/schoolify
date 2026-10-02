import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'exams'

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
      table
        .integer('class_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('classes')
        .onDelete('CASCADE')
      table
        .integer('subject_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('subjects')
        .onDelete('CASCADE')
      table
        .integer('teacher_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table
        .integer('term_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('terms')
        .onDelete('SET NULL')

      table.string('title', 200).notNullable()
      table.text('instructions').nullable()
      table.integer('duration_minutes').notNullable().defaultTo(30)
      table.boolean('shuffle_questions').notNullable().defaultTo(true)
      // Admin-controlled: show the score to the student right after submit.
      table.boolean('show_score_immediately').notNullable().defaultTo(false)

      // draft -> pending -> approved | rejected
      table.string('status', 20).notNullable().defaultTo('draft')
      table.text('review_note').nullable()
      table
        .integer('reviewed_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('reviewed_at').nullable()

      // Availability window (nullable = always open once approved)
      table.timestamp('opens_at').nullable()
      table.timestamp('closes_at').nullable()

      // Results gate for parent/student visibility after grading.
      table.timestamp('results_approved_at').nullable()
      table
        .integer('results_approved_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'status'])
      table.index(['class_id', 'subject_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
