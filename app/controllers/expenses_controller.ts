import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Expense from '#models/expense'
import { createExpenseValidator, updateExpenseValidator } from '#validators/expense'

export default class ExpensesController {
  async index({ school, request, serialize }: HttpContext) {
    const category = request.input('category')
    const from = request.input('from')
    const to = request.input('to')

    const query = Expense.query()
      .where('school_id', school.id)
      .preload('recordedBy')
      .orderBy('incurred_on', 'desc')

    if (category) query.where('category', String(category))
    if (from) query.where('incurred_on', '>=', String(from))
    if (to) query.where('incurred_on', '<=', String(to))

    const rows = await query
    const totalKobo = rows.reduce((sum, r) => sum + Number(r.amountKobo), 0)

    return serialize({
      rows: rows.map((r) => this.serialize(r)),
      totalKobo,
      totalNaira: totalKobo / 100,
    })
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createExpenseValidator)
    const row = await Expense.create({
      schoolId: school.id,
      category: payload.category,
      description: payload.description,
      amountKobo: Math.round(payload.amount * 100),
      incurredOn: DateTime.fromISO(payload.incurredOn),
      receiptUrl: payload.receiptUrl ?? null,
      notes: payload.notes ?? null,
      recordedByUserId: auth.getUserOrFail().id,
    })
    await row.load('recordedBy')
    response.status(201)
    return serialize(this.serialize(row))
  }

  async show({ school, params, response, serialize }: HttpContext) {
    const row = await Expense.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('recordedBy')
      .first()
    if (!row) return response.notFound({ message: 'Expense not found' })
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await Expense.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Expense not found' })

    const payload = await request.validateUsing(updateExpenseValidator)
    row.merge({
      category: payload.category ?? row.category,
      description: payload.description ?? row.description,
      amountKobo:
        payload.amount === undefined ? row.amountKobo : Math.round(payload.amount * 100),
      incurredOn: payload.incurredOn ? DateTime.fromISO(payload.incurredOn) : row.incurredOn,
      receiptUrl:
        payload.receiptUrl === undefined ? row.receiptUrl : payload.receiptUrl,
      notes: payload.notes === undefined ? row.notes : payload.notes,
    })
    await row.save()
    await row.load('recordedBy')
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await Expense.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Expense not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: Expense) {
    return {
      id: row.id,
      category: row.category,
      description: row.description,
      amountKobo: Number(row.amountKobo),
      amountNaira: Number(row.amountKobo) / 100,
      incurredOn: row.incurredOn?.toISODate(),
      receiptUrl: row.receiptUrl,
      notes: row.notes,
      recordedBy: row.recordedBy
        ? { id: row.recordedBy.id, fullName: row.recordedBy.fullName, email: row.recordedBy.email }
        : null,
      createdAt: row.createdAt,
    }
  }
}
