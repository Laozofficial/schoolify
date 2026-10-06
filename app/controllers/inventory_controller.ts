import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import InventoryItem from '#models/inventory_item'
import Supplier from '#models/supplier'
import Purchase from '#models/purchase'
import StockMovement from '#models/stock_movement'
import Expense from '#models/expense'
import { notifyUsers } from '#services/notify'

const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0

const itemValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(160),
    sku: vine.string().trim().maxLength(60).nullable().optional(),
    category: vine.string().trim().maxLength(60).nullable().optional(),
    unit: vine.string().trim().minLength(1).maxLength(30).optional(),
    store: vine.string().trim().maxLength(80).nullable().optional(),
    reorderLevel: vine.number().min(0).max(1e7).optional(),
    unitCostKobo: vine.number().min(0).max(1e12).optional(),
    openingQuantity: vine.number().min(0).max(1e7).optional(),
    active: vine.boolean().optional(),
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
  })
)

const supplierValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(160),
    contactName: vine.string().trim().maxLength(160).nullable().optional(),
    phone: vine.string().trim().maxLength(40).nullable().optional(),
    email: vine.string().trim().email().maxLength(160).nullable().optional(),
    address: vine.string().trim().maxLength(300).nullable().optional(),
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
  })
)

const issueValidator = vine.compile(
  vine.object({
    quantity: vine.number().min(1).max(1e7),
    issuedTo: vine.string().trim().minLength(1).maxLength(160),
    note: vine.string().trim().maxLength(300).nullable().optional(),
  })
)

const countValidator = vine.compile(
  vine.object({
    counted: vine.number().min(0).max(1e7),
    note: vine.string().trim().maxLength(300).nullable().optional(),
  })
)

const purchaseValidator = vine.compile(
  vine.object({
    supplierId: vine.number().positive().nullable().optional(),
    reference: vine.string().trim().maxLength(80).nullable().optional(),
    purchasedOn: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: vine.string().trim().maxLength(1000).nullable().optional(),
    recordExpense: vine.boolean().optional(),
    lines: vine
      .array(
        vine.object({
          itemId: vine.number().positive(),
          quantity: vine.number().min(1).max(1e7),
          unitCostKobo: vine.number().min(0).max(1e12),
        })
      )
      .minLength(1)
      .maxLength(100),
  })
)

export default class InventoryController {
  /* ---------------- items ---------------- */

  async items({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = InventoryItem.query().where('school_id', school.id).orderBy('name')
    if (qs.archived !== 'true') q.where('active', true)
    const rows = await q
    let list = rows.map((r) => this.itemJson(r))
    if (qs.low === 'true') list = list.filter((r) => r.low)
    return serialize(list)
  }

  async summary({ school, serialize }: HttpContext) {
    const rows = await InventoryItem.query().where('school_id', school.id).where('active', true)
    const since = DateTime.now().minus({ days: 30 }).toSQL()!
    const [spent] = await db.from('purchases').where('school_id', school.id).where('purchased_on', '>=', since.slice(0, 10)).sum('total_kobo as t')
    return serialize({
      items: rows.length,
      stockValueKobo: rows.reduce((t, r) => t + Math.max(r.quantity, 0) * n(r.unitCostKobo), 0),
      lowStock: rows.filter((r) => r.quantity <= r.reorderLevel).length,
      outOfStock: rows.filter((r) => r.quantity <= 0).length,
      purchases30dKobo: n((spent as any).t),
      categories: [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
      stores: [...new Set(rows.map((r) => r.store).filter(Boolean))].sort(),
    })
  }

  async storeItem({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(itemValidator)
    const item = await db.transaction(async (trx) => {
      const row = await InventoryItem.create(
        {
          schoolId: school.id,
          name: p.name,
          sku: p.sku ?? null,
          category: p.category ?? null,
          unit: p.unit ?? 'pcs',
          store: p.store ?? null,
          reorderLevel: Math.round(p.reorderLevel ?? 0),
          unitCostKobo: Math.round(p.unitCostKobo ?? 0),
          quantity: 0,
          active: true,
          notes: p.notes ?? null,
        },
        { client: trx }
      )
      const opening = Math.round(p.openingQuantity ?? 0)
      if (opening > 0) await this.move(trx, row, 'adjust', opening, { note: 'Opening stock', userId: auth.user?.id ?? null })
      return row
    })
    response.status(201)
    return serialize(this.itemJson(item))
  }

  async updateItem({ school, params, request, response, serialize }: HttpContext) {
    const row = await InventoryItem.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Item not found' })
    const p = await request.validateUsing(itemValidator)
    row.merge({
      name: p.name,
      sku: p.sku ?? null,
      category: p.category ?? null,
      unit: p.unit ?? row.unit,
      store: p.store ?? null,
      reorderLevel: Math.round(p.reorderLevel ?? row.reorderLevel),
      unitCostKobo: Math.round(p.unitCostKobo ?? n(row.unitCostKobo)),
      active: p.active ?? row.active,
      notes: p.notes ?? null,
    })
    await row.save()
    return serialize(this.itemJson(row))
  }

  async destroyItem({ school, params, response }: HttpContext) {
    const row = await InventoryItem.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Item not found' })
    const used = await StockMovement.query().where('item_id', row.id).whereNot('note', 'Opening stock').first()
    if (used) {
      // Keep the history: archive instead of deleting.
      row.active = false
      await row.save()
      return response.ok({ archived: true })
    }
    await row.delete()
    return response.noContent()
  }

  /** Give stock out to a person, class or department. */
  async issue({ school, auth, params, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(issueValidator)
    const result = await db.transaction(async (trx) => {
      const item = await InventoryItem.query({ client: trx }).where('school_id', school.id).where('id', params.id).forUpdate().first()
      if (!item) return { error: 404 as const }
      if (item.quantity < p.quantity) return { error: 422 as const, have: item.quantity, unit: item.unit }
      const wasAbove = item.quantity > item.reorderLevel
      await this.move(trx, item, 'out', -Math.round(p.quantity), { issuedTo: p.issuedTo, note: p.note ?? null, userId: auth.user?.id ?? null })
      return { item, crossed: wasAbove && item.quantity <= item.reorderLevel }
    })
    if ('error' in result) {
      if (result.error === 404) return response.notFound({ message: 'Item not found' })
      return response.unprocessableEntity({ message: `Only ${result.have} ${result.unit} in stock.` })
    }
    if (result.crossed) await this.alertLow(school.id, result.item)
    return serialize(this.itemJson(result.item))
  }

  /** Stock count: set the quantity to what is physically on the shelf. */
  async count({ school, auth, params, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(countValidator)
    const item = await db.transaction(async (trx) => {
      const row = await InventoryItem.query({ client: trx }).where('school_id', school.id).where('id', params.id).forUpdate().first()
      if (!row) return null
      const delta = Math.round(p.counted) - row.quantity
      if (delta !== 0) await this.move(trx, row, 'adjust', delta, { note: p.note || 'Stock count', userId: auth.user?.id ?? null })
      return row
    })
    if (!item) return response.notFound({ message: 'Item not found' })
    return serialize(this.itemJson(item))
  }

  async movements({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = db
      .from('stock_movements as m')
      .join('inventory_items as i', 'i.id', 'm.item_id')
      .leftJoin('users as u', 'u.id', 'm.recorded_by_user_id')
      .leftJoin('purchases as p', 'p.id', 'm.purchase_id')
      .leftJoin('suppliers as s', 's.id', 'p.supplier_id')
      .where('m.school_id', school.id)
      .orderBy('m.occurred_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(Math.min(Number(qs.limit ?? 200), 1000))
      .select(
        'm.id',
        'm.type',
        'm.quantity',
        'm.balance_after',
        'm.unit_cost_kobo',
        'm.issued_to',
        'm.note',
        'm.occurred_at',
        'i.id as item_id',
        'i.name as item_name',
        'i.unit',
        'u.full_name as recorded_by',
        's.name as supplier_name'
      )
    if (qs.itemId) q.where('m.item_id', Number(qs.itemId))
    if (qs.type) q.where('m.type', String(qs.type))
    const rows = await q
    return serialize(
      rows.map((r: any) => ({
        id: r.id,
        type: r.type,
        quantity: r.quantity,
        balanceAfter: r.balance_after,
        unitCostKobo: r.unit_cost_kobo != null ? n(r.unit_cost_kobo) : null,
        issuedTo: r.issued_to,
        note: r.note,
        at: r.occurred_at,
        itemId: r.item_id,
        itemName: r.item_name,
        unit: r.unit,
        recordedBy: r.recorded_by,
        supplierName: r.supplier_name,
      }))
    )
  }

  /* ---------------- purchases ---------------- */

  async purchases({ school, serialize }: HttpContext) {
    const rows = await db
      .from('purchases as p')
      .leftJoin('suppliers as s', 's.id', 'p.supplier_id')
      .leftJoin('users as u', 'u.id', 'p.recorded_by_user_id')
      .where('p.school_id', school.id)
      .orderBy('p.purchased_on', 'desc')
      .orderBy('p.id', 'desc')
      .limit(200)
      .select('p.*', 's.name as supplier_name', 'u.full_name as recorded_by')
    const lines = rows.length
      ? await db
          .from('stock_movements as m')
          .join('inventory_items as i', 'i.id', 'm.item_id')
          .whereIn(
            'm.purchase_id',
            rows.map((r: any) => r.id)
          )
          .select('m.purchase_id', 'm.quantity', 'm.unit_cost_kobo', 'i.name', 'i.unit')
      : []
    return serialize(
      rows.map((r: any) => ({
        id: r.id,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        reference: r.reference,
        purchasedOn: r.purchased_on,
        totalKobo: n(r.total_kobo),
        expenseId: r.expense_id,
        note: r.note,
        recordedBy: r.recorded_by,
        lines: (lines as any[])
          .filter((l) => l.purchase_id === r.id)
          .map((l) => ({ name: l.name, unit: l.unit, quantity: l.quantity, unitCostKobo: n(l.unit_cost_kobo) })),
      }))
    )
  }

  /** Receive a delivery: adds stock for every line and, optionally, books an expense. */
  async storePurchase({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(purchaseValidator)
    if (p.supplierId) {
      const sup = await Supplier.query().where('school_id', school.id).where('id', p.supplierId).first()
      if (!sup) return response.unprocessableEntity({ message: 'Supplier not found' })
    }
    const itemIds = [...new Set(p.lines.map((l) => l.itemId))]
    const found = await InventoryItem.query().where('school_id', school.id).whereIn('id', itemIds)
    if (found.length !== itemIds.length) return response.unprocessableEntity({ message: 'One of the items no longer exists.' })

    const purchase = await db.transaction(async (trx) => {
      const total = p.lines.reduce((t, l) => t + Math.round(l.quantity) * Math.round(l.unitCostKobo), 0)
      const row = await Purchase.create(
        {
          schoolId: school.id,
          supplierId: p.supplierId ?? null,
          reference: p.reference ?? null,
          purchasedOn: DateTime.fromISO(p.purchasedOn),
          totalKobo: total,
          note: p.note ?? null,
          recordedByUserId: auth.user?.id ?? null,
        },
        { client: trx }
      )
      for (const l of p.lines) {
        const item = await InventoryItem.query({ client: trx }).where('id', l.itemId).forUpdate().firstOrFail()
        await this.move(trx, item, 'in', Math.round(l.quantity), {
          unitCostKobo: Math.round(l.unitCostKobo),
          purchaseId: row.id,
          userId: auth.user?.id ?? null,
        })
        // Latest purchase price becomes the item's cost for stock value.
        item.unitCostKobo = Math.round(l.unitCostKobo)
        await item.useTransaction(trx).save()
      }
      if (p.recordExpense && total > 0) {
        const sup = p.supplierId ? await Supplier.find(p.supplierId, { client: trx }) : null
        const exp = await Expense.create(
          {
            schoolId: school.id,
            category: 'purchases',
            description: `Stock purchase${sup ? ` from ${sup.name}` : ''}${p.reference ? ` (${p.reference})` : ''}`.slice(0, 255),
            amountKobo: total,
            incurredOn: DateTime.fromISO(p.purchasedOn),
            notes: p.note ?? null,
            recordedByUserId: auth.user?.id ?? null,
          },
          { client: trx }
        )
        row.expenseId = exp.id
        await row.useTransaction(trx).save()
      }
      return row
    })
    response.status(201)
    return serialize({ id: purchase.id, totalKobo: n(purchase.totalKobo), expenseId: purchase.expenseId })
  }

  /* ---------------- suppliers ---------------- */

  async suppliers({ school, serialize }: HttpContext) {
    const rows = await Supplier.query().where('school_id', school.id).orderBy('name')
    const spend = await db.from('purchases').where('school_id', school.id).groupBy('supplier_id').select('supplier_id').sum('total_kobo as t').count('* as c')
    const bySup = new Map((spend as any[]).map((s) => [s.supplier_id, { t: n(s.t), c: Number(s.c) }]))
    return serialize(rows.map((r) => ({ ...r.serialize(), totalSpentKobo: bySup.get(r.id)?.t ?? 0, purchaseCount: bySup.get(r.id)?.c ?? 0 })))
  }

  async storeSupplier({ school, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(supplierValidator)
    const row = await Supplier.create({ schoolId: school.id, ...this.supplierFields(p) })
    response.status(201)
    return serialize(row.serialize())
  }

  async updateSupplier({ school, params, request, response, serialize }: HttpContext) {
    const row = await Supplier.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Supplier not found' })
    const p = await request.validateUsing(supplierValidator)
    row.merge(this.supplierFields(p))
    await row.save()
    return serialize(row.serialize())
  }

  async destroySupplier({ school, params, response }: HttpContext) {
    const row = await Supplier.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Supplier not found' })
    await row.delete()
    return response.noContent()
  }

  /* ---------------- helpers ---------------- */

  private supplierFields(p: Record<string, any>) {
    return {
      name: p.name,
      contactName: p.contactName ?? null,
      phone: p.phone ?? null,
      email: p.email ?? null,
      address: p.address ?? null,
      notes: p.notes ?? null,
    }
  }

  /** Apply a signed change to an item and append it to the ledger. */
  private async move(
    trx: TransactionClientContract,
    item: InventoryItem,
    type: 'in' | 'out' | 'adjust',
    delta: number,
    o: { unitCostKobo?: number; purchaseId?: number; issuedTo?: string; note?: string | null; userId: number | null }
  ) {
    item.quantity = item.quantity + delta
    await item.useTransaction(trx).save()
    await StockMovement.create(
      {
        schoolId: item.schoolId,
        itemId: item.id,
        type,
        quantity: delta,
        balanceAfter: item.quantity,
        unitCostKobo: o.unitCostKobo ?? null,
        purchaseId: o.purchaseId ?? null,
        issuedTo: o.issuedTo ?? null,
        note: o.note ?? null,
        recordedByUserId: o.userId,
        occurredAt: DateTime.now(),
      },
      { client: trx }
    )
  }

  private async alertLow(schoolId: number, item: InventoryItem) {
    const admins = await db
      .from('user_school_roles')
      .where('school_id', schoolId)
      .whereIn('role', ['super_admin', 'admin', 'accountant'])
      .select('user_id')
    await notifyUsers(
      admins.map((a: any) => a.user_id),
      {
        schoolId,
        kind: 'low_stock',
        title: `Low stock: ${item.name}`,
        body: `${item.quantity} ${item.unit} left (reorder at ${item.reorderLevel}).`,
        data: { kind: 'low_stock', itemId: item.id },
      }
    )
  }

  private itemJson(r: InventoryItem) {
    return {
      id: r.id,
      name: r.name,
      sku: r.sku,
      category: r.category,
      unit: r.unit,
      store: r.store,
      quantity: r.quantity,
      reorderLevel: r.reorderLevel,
      unitCostKobo: n(r.unitCostKobo),
      valueKobo: Math.max(r.quantity, 0) * n(r.unitCostKobo),
      low: r.quantity <= r.reorderLevel,
      active: r.active,
      notes: r.notes,
    }
  }
}
