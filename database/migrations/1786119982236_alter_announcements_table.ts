import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Extends flat role targeting with a composable rule engine. Any rule matching
 * = announcement visible. `target_roles` stays for backwards compat.
 *
 * Rule shape:
 *   { type: 'role', role: 'parent' }
 *   { type: 'role_in_class', role: 'parent' | 'student' | 'teacher', classId: 12 }
 *   { type: 'teachers_of_subject', subjectId: 3 }
 *   { type: 'users', userIds: [1, 4, 9] }
 */
export default class extends BaseSchema {
  protected tableName = 'announcements'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.jsonb('target_rules').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('target_rules')
    })
  }
}
