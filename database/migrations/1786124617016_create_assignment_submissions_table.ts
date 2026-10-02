import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'assignment_submissions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('assignment_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('assignments')
        .onDelete('CASCADE')
      table
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')
      table.text('content').nullable()
      table.string('attachment_url').nullable()
      table.timestamp('submitted_at').notNullable()
      table.decimal('score', 6, 2).nullable()
      table.text('feedback').nullable()
      table
        .integer('graded_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('graded_at').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['assignment_id', 'student_id'])
      table.index('student_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
