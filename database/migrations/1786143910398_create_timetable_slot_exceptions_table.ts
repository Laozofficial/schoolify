import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'timetable_slot_exceptions'

  /**
   * One-off, date-specific overrides for individual `timetable_slots`.
   * The weekly template is the source of truth; a row in this table
   * changes what happens for one specific calendar date only - tomorrow
   * the base template applies again.
   *
   * Each nullable column overrides the base slot's value when set. The
   * caller distinguishes "no override" (leave column NULL) from "clear
   * to nothing" (use `is_cancelled = true` to skip the slot for that
   * date). A NULL `subject_id` / `teacher_id` on an exception simply
   * means "keep the base slot's value" - the row survives so the notes
   * / other fields can still apply.
   */
  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('slot_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('timetable_slots')
        .onDelete('CASCADE')
      table.date('date').notNullable()
      // Nullable overrides - null means "inherit from base slot".
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
      table.text('notes').nullable()
      table.boolean('is_cancelled').notNullable().defaultTo(false)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['slot_id', 'date'])
      table.index(['date'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
