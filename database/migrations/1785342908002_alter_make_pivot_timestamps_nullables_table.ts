import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Pivot tables don't need timestamps for Lucid's attach() convenience method,
 * which doesn't set them by default. Making created_at nullable so attach()
 * works without extra plumbing.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('class_subjects', (table) => {
      table.timestamp('created_at').nullable().alter()
    })
    this.schema.alterTable('teacher_subjects', (table) => {
      table.timestamp('created_at').nullable().alter()
    })
    this.schema.alterTable('parent_students', (table) => {
      table.timestamp('created_at').nullable().alter()
    })
  }

  async down() {
    // no-op - safe to leave nullable
  }
}
