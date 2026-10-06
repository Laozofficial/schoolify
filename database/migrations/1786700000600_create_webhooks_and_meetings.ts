import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Other connections:
 * - webhook_endpoints / webhook_deliveries: signed outbound events so a
 *   school can plug Schoolify into Zapier, Make, n8n or its own systems.
 * - calendar_events.meeting_url: a Zoom link created from a connection.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('webhook_endpoints', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('url', 500).notNullable()
      table.string('description', 160).nullable()
      table.text('secret').notNullable() // encrypted signing secret
      table.jsonb('events').notNullable() // ['*'] or a list of event types
      table.boolean('active').notNullable().defaultTo(true)
      table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id'])
    })

    this.schema.createTable('webhook_deliveries', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('endpoint_id').unsigned().notNullable().references('id').inTable('webhook_endpoints').onDelete('CASCADE')
      table.string('event_id', 40).notNullable()
      table.string('event', 60).notNullable()
      table.jsonb('payload').notNullable()
      table.string('status', 12).notNullable().defaultTo('pending') // pending | delivered | failed
      table.integer('attempts').notNullable().defaultTo(0)
      table.integer('response_code').nullable()
      table.text('last_error').nullable()
      table.timestamp('delivered_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['endpoint_id', 'created_at'])
    })

    this.schema.alterTable('calendar_events', (table) => {
      table.string('meeting_url', 500).nullable()
      table.string('meeting_provider', 20).nullable()
    })
  }

  async down() {
    this.schema.alterTable('calendar_events', (table) => {
      table.dropColumn('meeting_url')
      table.dropColumn('meeting_provider')
    })
    this.schema.dropTable('webhook_deliveries')
    this.schema.dropTable('webhook_endpoints')
  }
}
