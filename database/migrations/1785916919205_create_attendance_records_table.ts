import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'attendance_records'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('attendance_day_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('attendance_days')
        .onDelete('CASCADE')
      table
        .integer('student_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('students')
        .onDelete('CASCADE')
      table
        .enu('status', ['present', 'absent', 'late', 'excused', 'sick'])
        .notNullable()
        .defaultTo('present')
      table.string('remark', 255).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['attendance_day_id', 'student_id'])
      table.index('student_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
