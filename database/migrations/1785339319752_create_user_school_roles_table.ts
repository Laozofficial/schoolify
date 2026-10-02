import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'user_school_roles'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table
        .integer('school_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('schools')
        .onDelete('CASCADE')
      table
        .enu('role', [
          'super_admin',
          'admin',
          'teacher',
          'non_academic_staff',
          'student',
          'parent',
          'accountant',
        ])
        .notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['user_id', 'school_id', 'role'])
      table.index(['school_id', 'role'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
