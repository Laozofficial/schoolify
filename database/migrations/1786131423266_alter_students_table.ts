import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Extra student profile fields. All nullable so existing records stay valid.
 */
export default class extends BaseSchema {
  protected tableName = 'students'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('phone', 32).nullable()
      table.string('email', 254).nullable()
      table.text('address').nullable()
      table.string('blood_group', 8).nullable()
      table.text('allergies').nullable()
      table.string('previous_school').nullable()
      table.string('religion', 60).nullable()
      table.string('home_language', 60).nullable()
      table.string('emergency_contact_name').nullable()
      table.string('emergency_contact_phone', 32).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('phone')
      table.dropColumn('email')
      table.dropColumn('address')
      table.dropColumn('blood_group')
      table.dropColumn('allergies')
      table.dropColumn('previous_school')
      table.dropColumn('religion')
      table.dropColumn('home_language')
      table.dropColumn('emergency_contact_name')
      table.dropColumn('emergency_contact_phone')
    })
  }
}
