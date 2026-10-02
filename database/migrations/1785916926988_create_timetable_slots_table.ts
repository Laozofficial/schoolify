import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'timetable_slots'

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
        .integer('period_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('timetable_periods')
        .onDelete('CASCADE')
      table.integer('day_of_week').notNullable()
      table
        .integer('subject_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('subjects')
        .onDelete('SET NULL')
      table
        .integer('teacher_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('notes', 200).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['class_id', 'day_of_week', 'period_id'])
      table.index(['school_id', 'class_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
