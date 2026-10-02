import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'calendar_events'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table
        .integer('school_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('schools')
        .onDelete('CASCADE')

      table.string('title').notNullable()
      table.text('description').nullable()
      table
        .enu('event_type', [
          'term_start',
          'term_end',
          'resumption',
          'holiday',
          'public_holiday',
          'pta',
          'sports',
          'excursion',
          'exam_week',
          'break',
          'mid_term_break',
          'visitation',
          'other',
        ])
        .notNullable()
        .defaultTo('other')

      table.date('starts_on').notNullable()
      table.date('ends_on').nullable()
      table.boolean('all_day').notNullable().defaultTo(true)
      table.string('color', 16).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['school_id', 'starts_on'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
