import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'announcements'

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
        .integer('author_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.string('title').notNullable()
      table.text('body').notNullable()
      /** JSON array of role names; null = every role at the school */
      table.jsonb('target_roles').nullable()
      table.boolean('pinned').notNullable().defaultTo(false)
      table.timestamp('published_at').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'published_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
