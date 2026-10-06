import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import FeeInvoice from '#models/fee_invoice'
import InvoiceInstallment from '#models/invoice_installment'
import Income from '#models/income'
import { scheduleState, splitEven } from '#services/installments'
import { emitEvent } from '#services/events'

const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const INCOME_CATEGORIES = ['donation', 'rental', 'sales', 'grant', 'event', 'other'] as const

const planValidator = vine.compile(
  vine.object({
    installments: vine
      .array(
        vine.object({
          label: vine.string().trim().maxLength(80).nullable().optional(),
          dueOn: vine.string().regex(DATE),
          amountKobo: vine.number().min(1).max(1e12),
        })
      )
      .maxLength(12),
  })
)

const splitValidator = vine.compile(
  vine.object({
    invoiceIds: vine.array(vine.number().positive()).optional(),
    termId: vine.number().positive().optional(),
    parts: vine.number().min(2).max(12),
    firstDueOn: vine.string().regex(DATE),
    monthsApart: vine.number().min(1).max(6).optional(),
    overwrite: vine.boolean().optional(),
  })
)

const incomeValidator = vine.compile(
  vine.object({
    category: vine.enum(INCOME_CATEGORIES),
    description: vine.string().trim().minLength(1).maxLength(255),
    payer: vine.string().trim().maxLength(160).nullable().optional(),
    amountKobo: vine.number().min(1).max(1e12),
    receivedOn: vine.string().regex(DATE),
    method: vine.string().trim().maxLength(20).nullable().optional(),
    reference: vine.string().trim().maxLength(80).nullable().optional(),
    bankAccountId: vine.number().positive().nullable().optional(),
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
  })
)

async function paidFor(invoiceIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!invoiceIds.length) return out
  const rows = await db.from('payments').whereIn('invoice_id', invoiceIds).groupBy('invoice_id').select('invoice_id').sum('amount_kobo as t')
  for (const r of rows as any[]) out.set(r.invoice_id, n(r.t))
  return out
}

export default class FinanceExtrasController {
  /* ---------------- instalments ---------------- */

  async plan({ school, params, response, serialize }: HttpContext) {
    const inv = await FeeInvoice.query().where('school_id', school.id).where('id', params.id).first()
    if (!inv) return response.notFound({ message: 'Invoice not found' })
    const rows = await InvoiceInstallment.query().where('invoice_id', inv.id).orderBy('position')
    const paid = (await paidFor([inv.id])).get(inv.id) ?? 0
    return serialize({ invoiceId: inv.id, totalKobo: n(inv.totalAmountKobo), paidKobo: paid, installments: scheduleState(rows, paid) })
  }

  /** Replace an invoice's schedule. The parts must add up to the invoice total. */
  async savePlan({ school, params, request, response, serialize }: HttpContext) {
    const inv = await FeeInvoice.query().where('school_id', school.id).where('id', params.id).first()
    if (!inv) return response.notFound({ message: 'Invoice not found' })
    if (inv.status === 'cancelled') return response.badRequest({ message: 'This invoice is cancelled.' })
    const { installments } = await request.validateUsing(planValidator)
    const total = n(inv.totalAmountKobo)
    const sum = installments.reduce((t, i) => t + Math.round(i.amountKobo), 0)
    if (installments.length && sum !== total) {
      return response.unprocessableEntity({
        message: `The instalments add up to ₦${(sum / 100).toLocaleString('en-NG')} but the invoice is ₦${(total / 100).toLocaleString('en-NG')}.`,
      })
    }
    const sorted = [...installments].sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    await db.transaction(async (trx) => {
      await InvoiceInstallment.query({ client: trx }).where('invoice_id', inv.id).delete()
      for (const [i, row] of sorted.entries()) {
        await InvoiceInstallment.create(
          {
            schoolId: school.id,
            invoiceId: inv.id,
            position: i + 1,
            label: row.label || null,
            dueOn: DateTime.fromISO(row.dueOn),
            amountKobo: Math.round(row.amountKobo),
          },
          { client: trx }
        )
      }
      if (sorted.length) {
        inv.useTransaction(trx)
        inv.dueOn = DateTime.fromISO(sorted[sorted.length - 1].dueOn)
        await inv.save()
      }
    })
    const rows = await InvoiceInstallment.query().where('invoice_id', inv.id).orderBy('position')
    const paid = (await paidFor([inv.id])).get(inv.id) ?? 0
    return serialize({ invoiceId: inv.id, totalKobo: total, paidKobo: paid, installments: scheduleState(rows, paid) })
  }

  /** Put many invoices (a term, or a selection) on equal monthly instalments. */
  async split({ school, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(splitValidator)
    if (!p.invoiceIds?.length && !p.termId) return response.unprocessableEntity({ message: 'Choose a term or some invoices.' })
    const q = FeeInvoice.query().where('school_id', school.id).whereNot('status', 'cancelled').whereNot('status', 'paid')
    if (p.invoiceIds?.length) q.whereIn('id', p.invoiceIds)
    if (p.termId) q.where('term_id', p.termId)
    const invoices = await q
    const existing = new Set(
      (await InvoiceInstallment.query().whereIn('invoice_id', invoices.map((i) => i.id).concat([-1])).select('invoice_id')).map((r) => r.invoiceId)
    )
    let planned = 0
    let skipped = 0
    const first = DateTime.fromISO(p.firstDueOn)
    for (const inv of invoices) {
      if (existing.has(inv.id) && !p.overwrite) {
        skipped++
        continue
      }
      const parts = splitEven(n(inv.totalAmountKobo), Math.round(p.parts))
      await db.transaction(async (trx) => {
        await InvoiceInstallment.query({ client: trx }).where('invoice_id', inv.id).delete()
        for (const [i, amount] of parts.entries()) {
          await InvoiceInstallment.create(
            {
              schoolId: school.id,
              invoiceId: inv.id,
              position: i + 1,
              label: `Instalment ${i + 1} of ${parts.length}`,
              dueOn: first.plus({ months: i * (p.monthsApart ?? 1) }),
              amountKobo: amount,
            },
            { client: trx }
          )
        }
        inv.useTransaction(trx)
        inv.dueOn = first.plus({ months: (parts.length - 1) * (p.monthsApart ?? 1) })
        await inv.save()
      })
      planned++
    }
    return serialize({ planned, skipped, considered: invoices.length })
  }

  /** Instalments due soon or overdue with money still owing, for the collections list. */
  async upcoming({ school, request, serialize }: HttpContext) {
    const days = Math.min(Number(request.input('days') ?? 14), 90)
    const until = DateTime.now().setZone('Africa/Lagos').plus({ days }).toISODate()!
    const rows = await InvoiceInstallment.query()
      .where('school_id', school.id)
      .where('due_on', '<=', until)
      .orderBy('due_on')
    if (!rows.length) return serialize([])
    const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))]
    const paid = await paidFor(invoiceIds)
    const invoices = await FeeInvoice.query().whereIn('id', invoiceIds).whereNot('status', 'cancelled').preload('student')
    const byInvoice = new Map(invoices.map((i) => [i.id, i]))
    const all = await InvoiceInstallment.query().whereIn('invoice_id', invoiceIds)
    const out: any[] = []
    for (const invId of invoiceIds) {
      const inv = byInvoice.get(invId)
      if (!inv) continue
      const states = scheduleState(
        all.filter((r) => r.invoiceId === invId),
        paid.get(invId) ?? 0
      )
      for (const s of states) {
        if (s.remainingKobo > 0 && s.dueOn <= until) {
          out.push({
            ...s,
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            studentId: inv.studentId,
            studentName: inv.student ? `${inv.student.firstName} ${inv.student.lastName}` : null,
          })
        }
      }
    }
    out.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    return serialize(out)
  }

  /* ---------------- other income ---------------- */

  async incomes({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = db
      .from('incomes as i')
      .leftJoin('users as u', 'u.id', 'i.recorded_by_user_id')
      .leftJoin('bank_accounts as b', 'b.id', 'i.bank_account_id')
      .where('i.school_id', school.id)
      .orderBy('i.received_on', 'desc')
      .orderBy('i.id', 'desc')
      .select('i.*', 'u.full_name as recorded_by', 'b.name as bank_account_name')
    if (qs.from) q.where('i.received_on', '>=', String(qs.from))
    if (qs.to) q.where('i.received_on', '<=', String(qs.to))
    if (qs.category) q.where('i.category', String(qs.category))
    const rows = await q.limit(1000)
    const list = rows.map((r: any) => ({
      id: r.id,
      category: r.category,
      description: r.description,
      payer: r.payer,
      amountKobo: n(r.amount_kobo),
      receivedOn: r.received_on,
      method: r.method,
      reference: r.reference,
      bankAccountId: r.bank_account_id,
      bankAccountName: r.bank_account_name,
      notes: r.notes,
      recordedBy: r.recorded_by,
    }))
    return serialize({ rows: list, totalKobo: list.reduce((t, r) => t + r.amountKobo, 0) })
  }

  async storeIncome({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(incomeValidator)
    const row = await Income.create({ schoolId: school.id, ...this.incomeFields(p), recordedByUserId: auth.user?.id ?? null })
    await emitEvent(school.id, 'income.recorded', {
      incomeId: row.id,
      category: p.category,
      description: p.description,
      payer: p.payer ?? null,
      amountKobo: Math.round(p.amountKobo),
      receivedOn: p.receivedOn,
    })
    response.status(201)
    return serialize({ id: row.id })
  }

  async updateIncome({ school, params, request, response, serialize }: HttpContext) {
    const row = await Income.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Not found' })
    const p = await request.validateUsing(incomeValidator)
    row.merge(this.incomeFields(p))
    await row.save()
    return serialize({ id: row.id })
  }

  async destroyIncome({ school, params, response }: HttpContext) {
    const row = await Income.query().where('school_id', school.id).where('id', params.id).first()
    if (!row) return response.notFound({ message: 'Not found' })
    await row.delete()
    return response.noContent()
  }

  private incomeFields(p: Record<string, any>) {
    return {
      category: p.category,
      description: p.description,
      payer: p.payer ?? null,
      amountKobo: Math.round(p.amountKobo),
      receivedOn: DateTime.fromISO(p.receivedOn),
      method: p.method ?? null,
      reference: p.reference ?? null,
      bankAccountId: p.bankAccountId ?? null,
      notes: p.notes ?? null,
    }
  }
}
