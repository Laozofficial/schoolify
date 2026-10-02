import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'exam_attempts'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('exam_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('exams')
        .onDelete('CASCADE')
      table
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')

      table.timestamp('started_at').notNullable()
      table.timestamp('submitted_at').nullable()
      table.string('status', 20).notNullable().defaultTo('in_progress') // in_progress | submitted
      table.integer('score').nullable()
      table.integer('total_marks').notNullable().defaultTo(0)
      // Per-student shuffled order of question ids.
      table.jsonb('question_order').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['exam_id', 'student_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
