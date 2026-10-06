import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Platform billing through TwelveAI Business:
 * - schools.trial_ends_at: every school starts on a free trial. Schools that
 *   already exist get a fresh 30 days from this release.
 * - school_subscriptions: one row per plan checkout. The TwelveAI
 *   subscription charges renewals itself; we mirror its state here.
 * - ai_credit_accounts / ai_credit_transactions: prepaid AI credit per
 *   school (kobo). Welcome grant, top-ups and per-call usage are all rows in
 *   the ledger; the account row holds the running balance.
 * - billing_payments: one-off platform payments (AI credit top-ups).
 * - ai_calls.cost_kobo: what each AI call cost the school.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('schools', (table) => {
      table.timestamp('trial_ends_at').nullable()
    })
    this.defer(async (db) => {
      await db.rawQuery(`UPDATE schools SET trial_ends_at = NOW() + INTERVAL '30 days' WHERE trial_ends_at IS NULL`)
    })

    this.schema.createTable('school_subscriptions', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('plan_key', 20).notNullable()
      table.string('interval_key', 12).notNullable() // monthly | termly | yearly
      table.bigInteger('amount_kobo').notNullable()
      table.string('mode', 8).notNullable() // test | live
      // incomplete | active | trialing | past_due | cancelled | expired | abandoned
      table.string('status', 16).notNullable().defaultTo('incomplete')
      table.string('gateway_id', 80).nullable().unique()
      table.string('gateway_reference', 120).nullable()
      table.text('checkout_url').nullable()
      table.timestamp('current_period_end').nullable()
      table.timestamp('next_charge_at').nullable()
      table.boolean('cancel_at_period_end').notNullable().defaultTo(false)
      table.string('card_brand', 30).nullable()
      table.string('card_last4', 4).nullable()
      table.string('last_failure_reason', 300).nullable()
      table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('last_synced_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'status'])
    })

    this.schema.createTable('ai_credit_accounts', (table) => {
      table.integer('school_id').unsigned().primary().references('id').inTable('schools').onDelete('CASCADE')
      table.bigInteger('balance_kobo').notNullable().defaultTo(0)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })

    this.schema.createTable('ai_credit_transactions', (table) => {
      table.bigIncrements('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('kind', 12).notNullable() // welcome | topup | usage | adjust
      table.bigInteger('amount_kobo').notNullable() // signed: + credit, - usage
      table.bigInteger('balance_after_kobo').notNullable()
      table.string('reference', 120).nullable().unique() // idempotency for grants and top-ups
      table.string('feature', 40).nullable()
      table.integer('ai_call_id').unsigned().nullable()
      table.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.string('note', 200).nullable()
      table.timestamp('created_at').notNullable()
      table.index(['school_id', 'created_at'])
    })

    this.schema.createTable('billing_payments', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('kind', 16).notNullable() // ai_credits
      table.string('reference', 120).notNullable().unique()
      table.bigInteger('amount_kobo').notNullable()
      table.string('mode', 8).notNullable()
      table.string('status', 12).notNullable().defaultTo('pending') // pending | successful | failed
      table.text('checkout_url').nullable()
      table.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('paid_at').nullable()
      table.timestamp('last_checked_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['status', 'created_at'])
      table.index(['school_id', 'created_at'])
    })

    this.schema.alterTable('ai_calls', (table) => {
      table.integer('cost_kobo').notNullable().defaultTo(0)
    })
  }

  async down() {
    this.schema.alterTable('ai_calls', (table) => table.dropColumn('cost_kobo'))
    this.schema.dropTable('billing_payments')
    this.schema.dropTable('ai_credit_transactions')
    this.schema.dropTable('ai_credit_accounts')
    this.schema.dropTable('school_subscriptions')
    this.schema.alterTable('schools', (table) => table.dropColumn('trial_ends_at'))
  }
}
