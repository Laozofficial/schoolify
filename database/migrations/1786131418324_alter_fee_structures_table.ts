import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Multi-class fee structures. The old `class_id` column stays for backwards
 * compat (writes now null it out); the new `class_ids` jsonb array is the
 * source of truth. `null` still means "applies to any class".
 */
export default class extends BaseSchema {
  protected tableName = 'fee_structures'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.jsonb('class_ids').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('class_ids')
    })
  }
}
