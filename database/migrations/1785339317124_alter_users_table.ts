import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('surname').nullable()
      table.string('phone', 32).nullable().unique()
      table.boolean('must_change_password').notNullable().defaultTo(false)
      table.timestamp('last_login_at').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('surname')
      table.dropColumn('phone')
      table.dropColumn('must_change_password')
      table.dropColumn('last_login_at')
    })
  }
}
