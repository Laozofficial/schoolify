import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Gate sign-in/out for students and staff. One row per scan or check-in.
 * Students are identified by student_id, staff by user_id.
 */
export default class extends BaseSchema {
  protected tableName = 'gate_events'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('person_type', 10).notNullable() // student | staff
      table.integer('student_id').unsigned().nullable().references('id').inTable('students').onDelete('CASCADE')
      table.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('direction', 4).notNullable() // in | out
      table.string('method', 10).notNullable() // qr | manual | gps
      table.timestamp('occurred_at').notNullable()
      table.date('day').notNullable() // school-local date, for daily rollups
      table.boolean('late').notNullable().defaultTo(false)
      table.integer('recorded_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.decimal('lat', 10, 7).nullable()
      table.decimal('lng', 10, 7).nullable()
      table.integer('distance_m').nullable()
      table.string('device', 80).nullable()
      table.string('note', 300).nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'day'])
      table.index(['school_id', 'student_id', 'day'])
      table.index(['school_id', 'user_id', 'day'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
