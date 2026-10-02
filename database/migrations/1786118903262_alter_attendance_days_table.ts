import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Attendance is marked twice per school day in Nigerian primary/secondary
 * schools - once mid-morning, once after lunch. Each becomes its own row so
 * students/parents see both, and teachers can lock each independently.
 */
export default class extends BaseSchema {
  protected tableName = 'attendance_days'

  async up() {
    // 1) add nullable enum with a default so new inserts already work
    this.schema.alterTable(this.tableName, (table) => {
      table.enu('session', ['morning', 'afternoon']).notNullable().defaultTo('morning')
    })
    // 2) swap the uniqueness constraint to include session
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['class_id', 'date'])
      table.unique(['class_id', 'date', 'session'])
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['class_id', 'date', 'session'])
      table.unique(['class_id', 'date'])
      table.dropColumn('session')
    })
  }
}
