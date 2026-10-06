import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Child pickup: adults a guardian has authorised to collect a child
 * (driver, aunt, older sibling), and a server-side log of every release
 * or refusal at the gate, shared by all gate devices.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('authorized_pickups', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('student_id').unsigned().notNullable().references('id').inTable('students').onDelete('CASCADE')
      table.string('full_name', 160).notNullable()
      table.string('phone', 40).nullable()
      table.string('relationship', 60).nullable()
      table.string('photo_url', 500).nullable()
      table.date('valid_until').nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.integer('added_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'student_id'])
    })

    this.schema.createTable('pickup_logs', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('student_id').unsigned().notNullable().references('id').inTable('students').onDelete('CASCADE')
      table.string('outcome', 10).notNullable() // released | refused
      table.string('method', 10).notNullable() // code | qr
      table.string('collector_type', 12).nullable() // guardian | authorized | other
      table.integer('collector_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.integer('authorized_pickup_id').unsigned().nullable().references('id').inTable('authorized_pickups').onDelete('SET NULL')
      table.string('collector_name', 160).nullable()
      table.integer('recorded_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.string('note', 300).nullable()
      table.timestamp('occurred_at').notNullable()
      table.date('day').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'day'])
      table.index(['school_id', 'student_id'])
    })
  }

  async down() {
    this.schema.dropTable('pickup_logs')
    this.schema.dropTable('authorized_pickups')
  }
}
