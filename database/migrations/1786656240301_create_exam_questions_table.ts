import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'exam_questions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('exam_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('exams')
        .onDelete('CASCADE')
      // mcq | true_false (both auto-graded via correct_index)
      table.string('type', 20).notNullable().defaultTo('mcq')
      table.text('prompt').notNullable()
      // Array of option strings (True/False stored as ['True','False']).
      table.jsonb('options').notNullable()
      table.integer('correct_index').notNullable()
      table.integer('marks').notNullable().defaultTo(1)
      table.integer('order_index').notNullable().defaultTo(0)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['exam_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
