import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'permission_overrides'

  /**
   * Per-staff permission grants that override role defaults. Each row is
   * one (user, school, resource, action) decision. `effect` is 'allow'
   * (grant beyond the role) or 'deny' (revoke what the role would allow).
   * Absence of a row means "inherit the role default".
   */
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
      table.string('resource', 40).notNullable()
      table.string('action', 20).notNullable() // create | read | update | delete
      table.string('effect', 10).notNullable() // allow | deny
      table
        .integer('granted_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['user_id', 'school_id', 'resource', 'action'])
      table.index(['user_id', 'school_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
