import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Inventory: items with a running quantity, suppliers, purchases (one
 * receipt with many lines) and an append-only movement ledger. The item's
 * quantity always equals the sum of its movements.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('suppliers', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('name', 160).notNullable()
      table.string('contact_name', 160).nullable()
      table.string('phone', 40).nullable()
      table.string('email', 160).nullable()
      table.string('address', 300).nullable()
      table.text('notes').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id'])
    })

    this.schema.createTable('inventory_items', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.string('name', 160).notNullable()
      table.string('sku', 60).nullable()
      table.string('category', 60).nullable()
      table.string('unit', 30).notNullable().defaultTo('pcs')
      table.string('store', 80).nullable() // store room / location
      table.integer('quantity').notNullable().defaultTo(0)
      table.integer('reorder_level').notNullable().defaultTo(0)
      table.bigInteger('unit_cost_kobo').notNullable().defaultTo(0)
      table.boolean('active').notNullable().defaultTo(true)
      table.text('notes').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'active'])
    })

    this.schema.createTable('purchases', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('supplier_id').unsigned().nullable().references('id').inTable('suppliers').onDelete('SET NULL')
      table.string('reference', 80).nullable()
      table.date('purchased_on').notNullable()
      table.bigInteger('total_kobo').notNullable().defaultTo(0)
      table.integer('expense_id').unsigned().nullable().references('id').inTable('expenses').onDelete('SET NULL')
      table.text('note').nullable()
      table.integer('recorded_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'purchased_on'])
    })

    this.schema.createTable('stock_movements', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('item_id').unsigned().notNullable().references('id').inTable('inventory_items').onDelete('CASCADE')
      table.string('type', 10).notNullable() // in | out | adjust
      table.integer('quantity').notNullable() // signed change
      table.integer('balance_after').notNullable()
      table.bigInteger('unit_cost_kobo').nullable()
      table.integer('purchase_id').unsigned().nullable().references('id').inTable('purchases').onDelete('SET NULL')
      table.string('issued_to', 160).nullable()
      table.string('note', 300).nullable()
      table.integer('recorded_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('occurred_at').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['school_id', 'occurred_at'])
      table.index(['item_id'])
    })
  }

  async down() {
    this.schema.dropTable('stock_movements')
    this.schema.dropTable('purchases')
    this.schema.dropTable('inventory_items')
    this.schema.dropTable('suppliers')
  }
}
