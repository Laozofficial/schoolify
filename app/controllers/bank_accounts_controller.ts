import type { HttpContext } from '@adonisjs/core/http'
import BankAccount from '#models/bank_account'
import {
  createBankAccountValidator,
  updateBankAccountValidator,
} from '#validators/operations'

export default class BankAccountsController {
  async index({ school, serialize }: HttpContext) {
    const rows = await BankAccount.query()
      .where('school_id', school.id)
      .orderBy('name', 'asc')
    return serialize(rows.map(this.serialize))
  }

  async store({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createBankAccountValidator)
    const row = await BankAccount.create({
      schoolId: school.id,
      name: payload.name,
      bankName: payload.bankName,
      accountNumber: payload.accountNumber,
      accountType: payload.accountType ?? null,
      openingBalanceKobo: payload.openingBalanceKobo ?? 0,
      notes: payload.notes ?? null,
      isActive: payload.isActive ?? true,
    })
    response.status(201)
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await BankAccount.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Account not found' })
    const payload = await request.validateUsing(updateBankAccountValidator)
    row.merge(payload)
    await row.save()
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await BankAccount.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Account not found' })
    await row.delete()
    return response.noContent()
  }

  private serialize(row: BankAccount) {
    return {
      id: row.id,
      name: row.name,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      accountType: row.accountType,
      openingBalanceKobo: Number(row.openingBalanceKobo),
      notes: row.notes,
      isActive: row.isActive,
      createdAt: row.createdAt,
    }
  }
}
