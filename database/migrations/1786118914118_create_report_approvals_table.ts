import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * A report card is only visible to a student/parent once their (term,student)
 * row exists here. Staff always see reports. Admins approve either one-by-one
 * or the whole class in bulk from the Results → Approvals tab.
 */
export default class extends BaseSchema {
  protected tableName = 'report_approvals'

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
        .integer('approved_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('approved_at').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['term_id', 'student_id'])
      table.index('term_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
