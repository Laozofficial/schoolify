import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'leave_requests'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Optional supporting document (medical note, letter, etc.) uploaded
      // via Cloudinary. Stored as a URL.
      table.string('attachment_url', 500).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('attachment_url')
    })
  }
}
