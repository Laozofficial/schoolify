import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Connections + messaging centre.
 *
 * - integrations: a school's own provider accounts (SMS, email, WhatsApp,
 *   meetings, webhooks). Secrets are stored encrypted with the app key.
 * - message_templates: reusable bodies with {{tokens}}.
 * - message_campaigns: one send (manual or automatic) to an audience.
 * - message_deliveries: one row per recipient per channel, with provider
 *   status updated from delivery webhooks.
 * - schools.settings: per-school switches (automations, modules, gate).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('integrations', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('kind', 20).notNullable() // sms | email | whatsapp | meetings | webhook | payments
      table.string('provider', 40).notNullable()
      table.string('label', 120).nullable()
      table.string('status', 20).notNullable().defaultTo('connected') // connected | error | disabled
      table.jsonb('config').nullable() // non-secret settings (sender id, from address, region)
      table.text('secrets').nullable() // encrypted JSON
      table.boolean('is_default').notNullable().defaultTo(false)
      table.string('hook_token', 64).notNullable().unique() // inbound webhook path secret
      table.timestamp('last_tested_at').nullable()
      table.text('last_error').nullable()
      table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'kind'])
    })

    this.schema.createTable('message_templates', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('name', 120).notNullable()
      table.string('channel', 20).notNullable().defaultTo('any') // any | sms | email | whatsapp
      table.string('subject', 200).nullable()
      table.text('body').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id'])
    })

    this.schema.createTable('message_campaigns', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('title', 200).notNullable()
      table.jsonb('channels').notNullable() // ['sms','email','whatsapp','in_app']
      table.jsonb('audience').nullable()
      table.string('subject', 200).nullable()
      table.text('body').notNullable()
      table.string('source', 20).notNullable().defaultTo('manual') // manual | automation
      table.string('event', 40).nullable() // absence, invoice, payment, results, pickup, gate
      table.string('status', 20).notNullable().defaultTo('queued') // queued | sending | done
      table.integer('total').notNullable().defaultTo(0)
      table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'created_at'])
    })

    this.schema.createTable('message_deliveries', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('campaign_id').unsigned().nullable().references('id').inTable('message_campaigns').onDelete('CASCADE')
      table.string('channel', 20).notNullable()
      table.integer('integration_id').unsigned().nullable().references('id').inTable('integrations').onDelete('SET NULL')
      table.string('provider', 40).nullable()
      table.integer('recipient_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.integer('student_id').unsigned().nullable().references('id').inTable('students').onDelete('SET NULL')
      table.string('recipient_name', 160).nullable()
      table.string('to_address', 200).nullable()
      table.string('subject', 200).nullable()
      table.text('body').notNullable()
      table.string('status', 20).notNullable().defaultTo('queued') // queued | sent | delivered | failed | skipped
      table.string('provider_message_id', 200).nullable()
      table.text('error').nullable()
      table.timestamp('sent_at').nullable()
      table.timestamp('delivered_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'created_at'])
      table.index(['campaign_id'])
      table.index(['provider', 'provider_message_id'])
    })

    this.schema.alterTable('schools', (table) => {
      table.jsonb('settings').nullable()
    })
  }

  async down() {
    this.schema.alterTable('schools', (table) => {
      table.dropColumn('settings')
    })
    this.schema.dropTable('message_deliveries')
    this.schema.dropTable('message_campaigns')
    this.schema.dropTable('message_templates')
    this.schema.dropTable('integrations')
  }
}
