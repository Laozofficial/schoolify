import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'students'

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
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table
        .integer('class_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('classes')
        .onDelete('SET NULL')

      table.string('admission_number').notNullable()
      table.string('first_name').notNullable()
      table.string('middle_name').nullable()
      table.string('last_name').notNullable()
      table.date('date_of_birth').nullable()
      table.enu('gender', ['male', 'female', 'other']).nullable()
      table.integer('admission_year').nullable()
      table.string('photo_url').nullable()
      table.text('medical_notes').nullable()
      table.boolean('is_archived').notNullable().defaultTo(false)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['school_id', 'admission_number'])
      table.index(['school_id', 'class_id'])
      table.index(['school_id', 'is_archived'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
