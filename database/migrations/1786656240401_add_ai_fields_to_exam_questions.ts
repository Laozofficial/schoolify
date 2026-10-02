import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Topic + difficulty tags (needed for weak-topic analysis and practice sets)
 * and an explanation of the correct answer (shown to students only after
 * results are published).
 */
export default class extends BaseSchema {
  protected tableName = 'exam_questions'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('topic', 120).nullable()
      // easy | medium | hard
      table.string('difficulty', 10).nullable()
      table.text('explanation').nullable()
      table.boolean('ai_generated').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('topic')
      table.dropColumn('difficulty')
      table.dropColumn('explanation')
      table.dropColumn('ai_generated')
    })
  }
}
