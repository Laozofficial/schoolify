import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'notification_dispatches'

  /**
   * Idempotency ledger for the recurring period-reminder job. Every alert
   * we've already fired is recorded here so the minute-by-minute cron
   * never double-alerts. Keyed by (userId, slotId, forDate, kind).
   */
  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.integer('user_id').unsigned().notNullable()
      table.integer('slot_id').unsigned().notNullable()
      table.date('for_date').notNullable()
      table.string('kind', 40).notNullable()
      table.timestamp('created_at').notNullable()

      table.unique(['user_id', 'slot_id', 'for_date', 'kind'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
