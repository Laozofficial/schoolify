import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'scores'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('term_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('terms')
        .onDelete('CASCADE')
      table
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')
      table
        .integer('subject_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('subjects')
        .onDelete('CASCADE')
      table
        .integer('assessment_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('assessments')
        .onDelete('CASCADE')
      table.decimal('score', 6, 2).notNullable()
      table
        .integer('entered_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['term_id', 'student_id', 'subject_id', 'assessment_id'])
      table.index(['term_id', 'subject_id'])
      table.index(['term_id', 'student_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
