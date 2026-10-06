import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Payroll: one pay profile per staff member, monthly runs, and a payslip
 * per staff member per run. Payslips keep a snapshot of every line and the
 * bank details used, so later profile edits never rewrite history.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('payroll_profiles', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.bigInteger('base_salary_kobo').notNullable().defaultTo(0)
      table.jsonb('allowances').nullable() // [{ name, amountKobo }]
      table.jsonb('deductions').nullable() // [{ name, amountKobo }]
      table.decimal('pension_percent', 5, 2).notNullable().defaultTo(0)
      table.bigInteger('tax_kobo').notNullable().defaultTo(0) // monthly PAYE set by the school
      table.string('bank_name', 120).nullable()
      table.string('account_number', 20).nullable()
      table.string('account_name', 160).nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['school_id', 'user_id'])
    })

    this.schema.createTable('payroll_runs', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('period', 7).notNullable() // YYYY-MM
      table.string('status', 12).notNullable().defaultTo('draft') // draft | approved | paid
      table.bigInteger('gross_kobo').notNullable().defaultTo(0)
      table.bigInteger('deductions_kobo').notNullable().defaultTo(0)
      table.bigInteger('net_kobo').notNullable().defaultTo(0)
      table.text('notes').nullable()
      table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.integer('approved_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('approved_at').nullable()
      table.timestamp('paid_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['school_id', 'period'])
    })

    this.schema.createTable('payslips', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('run_id').unsigned().notNullable().references('id').inTable('payroll_runs').onDelete('CASCADE')
      table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('staff_name', 160).notNullable()
      table.jsonb('lines').notNullable() // [{ kind: 'earning'|'deduction', name, amountKobo }]
      table.bigInteger('gross_kobo').notNullable()
      table.bigInteger('deductions_kobo').notNullable()
      table.bigInteger('net_kobo').notNullable()
      table.string('bank_name', 120).nullable()
      table.string('account_number', 20).nullable()
      table.string('account_name', 160).nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['run_id', 'user_id'])
      table.index(['school_id', 'user_id'])
    })
  }

  async down() {
    this.schema.dropTable('payslips')
    this.schema.dropTable('payroll_runs')
    this.schema.dropTable('payroll_profiles')
  }
}
