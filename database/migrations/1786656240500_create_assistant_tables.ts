import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Family assistant (parents + students): conversations per channel and the
 * messages in them. `external_id` holds the WhatsApp message id so a
 * webhook retry is never answered twice.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('assistant_conversations', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      // web | whatsapp
      table.string('channel', 20).notNullable().defaultTo('web')
      table.string('title', 200).nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['user_id', 'school_id', 'channel'])
    })

    this.schema.createTable('assistant_messages', (table) => {
      table.increments('id').notNullable()
      table
        .integer('conversation_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('assistant_conversations')
        .onDelete('CASCADE')
      // user | assistant
      table.string('role', 20).notNullable()
      table.text('content').notNullable()
      // Tools used to answer, for transparency and debugging.
      table.jsonb('meta').nullable()
      table.string('external_id', 120).nullable().unique()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['conversation_id', 'id'])
    })

    this.schema.createTable('whatsapp_links', (table) => {
      table.increments('id').notNullable()
      table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      // E.164 digits without '+', set once the parent proves the number.
      table.string('phone', 20).nullable().unique()
      // One-time code the parent sends from WhatsApp to prove the number.
      table.string('code', 10).nullable()
      table.timestamp('code_expires_at').nullable()
      table.timestamp('linked_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['user_id', 'school_id'])
      table.index(['code'])
    })
  }

  async down() {
    this.schema.dropTable('whatsapp_links')
    this.schema.dropTable('assistant_messages')
    this.schema.dropTable('assistant_conversations')
  }
}
