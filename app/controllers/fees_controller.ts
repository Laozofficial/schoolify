import type { HttpContext } from '@adonisjs/core/http'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import FeeStructure from '#models/fee_structure'
import FeeItem from '#models/fee_item'
import FeeInvoice, { type InvoiceStatus } from '#models/fee_invoice'
import FeeInvoiceItem from '#models/fee_invoice_item'
import Payment from '#models/payment'
import Student from '#models/student'
import { notifyInvoiceIssued, notifyPaymentRecorded } from '#services/notify'
import {
  createFeeStructureValidator,
  updateFeeStructureValidator,
  generateInvoicesValidator,
  createManualInvoiceValidator,
  recordPaymentValidator,
  bulkPaymentValidator,
} from '#validators/fees'

function toKobo(n: number): number {
  return Math.round(n * 100)
}

export default class FeesController {
  /* ==================== FEE STRUCTURES ==================== */
  async listStructures({ school, serialize }: HttpContext) {
    const rows = await FeeStructure.query()
      .where('school_id', school.id)
      .preload('items')
      .preload('schoolClass')
      .preload('term')
      .orderBy('name', 'asc')
    return serialize(rows.map((r) => this.serializeStructure(r)))
  }

  async createStructure({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createFeeStructureValidator)
    // Prefer new classIds; fall back to legacy classId as a single-element array.
    const classIds =
      payload.classIds && payload.classIds.length > 0
        ? payload.classIds
        : payload.classId
          ? [payload.classId]
          : null
    const row = await db.transaction(async (trx) => {
      const s = await FeeStructure.create(
        {
          schoolId: school.id,
          name: payload.name,
          classId: classIds?.[0] ?? null, // legacy col kept in sync with first
          classIds,
          termId: payload.termId ?? null,
        },
        { client: trx }
      )
      for (const it of payload.items) {
        await FeeItem.create(
          {
            feeStructureId: s.id,
            description: it.description,
            amountKobo: toKobo(it.amount),
            isOptional: it.isOptional ?? false,
          },
          { client: trx }
        )
      }
      return s
    })
    await row.load('items')
    await row.load('schoolClass')
    await row.load('term')
    response.status(201)
    return serialize(this.serializeStructure(row))
  }

  async updateStructure({ school, params, request, response, serialize }: HttpContext) {
    const row = await FeeStructure.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Fee structure not found' })
    const payload = await request.validateUsing(updateFeeStructureValidator)

    await db.transaction(async (trx) => {
      row.useTransaction(trx)
      // classIds takes precedence when explicitly set (including empty array).
      const nextClassIds =
        payload.classIds === undefined
          ? row.classIds
          : payload.classIds && payload.classIds.length > 0
            ? payload.classIds
            : null
      row.merge({
        name: payload.name ?? row.name,
        classId:
          payload.classId === undefined
            ? nextClassIds?.[0] ?? row.classId
            : payload.classId,
        classIds: nextClassIds,
        termId: payload.termId === undefined ? row.termId : payload.termId,
      })
      await row.save()
      if (payload.items) {
        await FeeItem.query({ client: trx }).where('fee_structure_id', row.id).delete()
        for (const it of payload.items) {
          await FeeItem.create(
            {
              feeStructureId: row.id,
              description: it.description,
              amountKobo: toKobo(it.amount),
              isOptional: it.isOptional ?? false,
            },
            { client: trx }
          )
        }
      }
    })
    await row.load('items')
    await row.load('schoolClass')
    await row.load('term')
    return serialize(this.serializeStructure(row))
  }

  async destroyStructure({ school, params, response }: HttpContext) {
    const row = await FeeStructure.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Fee structure not found' })
    await row.delete()
    return response.noContent()
  }

  /* ==================== INVOICES ==================== */
  /**
   * POST /schools/:sid/invoices/generate
   * Bulk-generate one invoice per student in the given classes.
   * Skips students who already have an invoice for (student, term, structure).
   */
  async generateInvoices({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(generateInvoicesValidator)
    const structure = await FeeStructure.query()
      .where('id', payload.feeStructureId)
      .where('school_id', school.id)
      .preload('items')
      .first()
    if (!structure) return response.notFound({ message: 'Fee structure not found' })

    const total = structure.items.reduce((s, i) => s + Number(i.amountKobo), 0)
    const students = await Student.query()
      .where('school_id', school.id)
      .where('is_archived', false)
      .whereIn('class_id', payload.classIds)

    let created = 0
    let skipped = 0
    // Collect the freshly-created invoices so we can notify recipients
    // AFTER the transaction commits.
    const newInvoices: {
      studentId: number
      invoiceId: number
      invoiceNumber: string
    }[] = []

    await db.transaction(async (trx) => {
      for (const stu of students) {
        const existing = await FeeInvoice.query({ client: trx })
          .where('student_id', stu.id)
          .where('term_id', payload.termId)
          .where('fee_structure_id', structure.id)
          .first()
        if (existing) {
          skipped += 1
          continue
        }

        const invoice = await FeeInvoice.create(
          {
            schoolId: school.id,
            studentId: stu.id,
            termId: payload.termId,
            feeStructureId: structure.id,
            invoiceNumber: await this.nextInvoiceNumber(school.id, trx),
            totalAmountKobo: total,
            status: 'pending' as InvoiceStatus,
            issuedOn: DateTime.now(),
            dueOn: payload.dueOn ? DateTime.fromISO(payload.dueOn) : null,
          },
          { client: trx }
        )
        for (const item of structure.items) {
          await FeeInvoiceItem.create(
            {
              invoiceId: invoice.id,
              description: item.description,
              amountKobo: Number(item.amountKobo),
            },
            { client: trx }
          )
        }
        newInvoices.push({
          studentId: stu.id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        })
        created += 1
      }
    })

    // In-app notifications to each student + their parents.
    for (const inv of newInvoices) {
      await notifyInvoiceIssued({
        schoolId: school.id,
        studentId: inv.studentId,
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        totalKobo: total,
        dueOn: payload.dueOn ?? null,
      })
    }

    return serialize({ created, skipped, total })
  }

  async listInvoices({ school, auth, request, serialize }: HttpContext) {
    const status = request.input('status')
    const termId = request.input('termId')
    const studentId = request.input('studentId')
    const q = request.input('q')

    const query = FeeInvoice.query()
      .where('school_id', school.id)
      .preload('student')
      .preload('term')
      .preload('payments')
      .orderBy('issued_on', 'desc')

    if (status) query.where('status', String(status))
    if (termId) query.where('term_id', Number(termId))
    if (studentId) query.where('student_id', Number(studentId))
    if (q) {
      query.where((sub) =>
        sub
          .whereILike('invoice_number', `%${q}%`)
          .orWhereHas('student', (s) =>
            s
              .whereILike('first_name', `%${q}%`)
              .orWhereILike('last_name', `%${q}%`)
              .orWhereILike('admission_number', `%${q}%`)
          )
      )
    }

    // Parents see only their wards' invoices
    const user = auth.getUserOrFail()
    const roles = await user.rolesAtSchool(school.id)
    const isStaff = roles.some((r) => ['super_admin', 'admin', 'accountant', 'teacher'].includes(r))
    if (!isStaff && roles.includes('parent')) {
      const wards = await user.related('wards').query().where('school_id', school.id)
      query.whereIn('student_id', wards.map((w) => w.id))
    }

    const rows = await query
    return serialize(rows.map((r) => this.serializeInvoice(r)))
  }

  async showInvoice({ school, params, response, serialize }: HttpContext) {
    const row = await FeeInvoice.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .preload('student')
      .preload('term')
      .preload('items')
      .preload('payments', (q) => q.preload('recordedBy'))
      .first()
    if (!row) return response.notFound({ message: 'Invoice not found' })
    return serialize(this.serializeInvoice(row, true))
  }

  /* ==================== PAYMENTS ==================== */
  async recordPayment({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(recordPaymentValidator)
    const invoice = await FeeInvoice.query()
      .where('id', payload.invoiceId)
      .where('school_id', school.id)
      .preload('payments')
      .first()
    if (!invoice) return response.notFound({ message: 'Invoice not found' })
    if (invoice.status === 'cancelled') {
      return response.badRequest({ message: 'Invoice is cancelled' })
    }

    const paidSoFar = invoice.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
    const outstanding = Number(invoice.totalAmountKobo) - paidSoFar
    const amountKobo = toKobo(payload.amount)
    if (amountKobo <= 0) return response.badRequest({ message: 'Amount must be positive' })
    if (amountKobo > outstanding) {
      return response.badRequest({
        message: `Payment exceeds outstanding ₦${(outstanding / 100).toFixed(2)}`,
      })
    }

    const payment = await db.transaction(async (trx) => {
      const p = await Payment.create(
        {
          schoolId: school.id,
          invoiceId: invoice.id,
          studentId: invoice.studentId,
          amountKobo,
          method: payload.method,
          reference: payload.reference ?? null,
          notes: payload.notes ?? null,
          paidAt: payload.paidAt ? DateTime.fromISO(payload.paidAt) : DateTime.now(),
          recordedByUserId: auth.getUserOrFail().id,
        },
        { client: trx }
      )
      const newPaid = paidSoFar + amountKobo
      invoice.useTransaction(trx)
      invoice.status =
        newPaid >= Number(invoice.totalAmountKobo)
          ? 'paid'
          : newPaid > 0
            ? 'partial'
            : 'pending'
      await invoice.save()
      return p
    })
    await payment.load('recordedBy')

    await notifyPaymentRecorded({
      schoolId: school.id,
      studentId: invoice.studentId,
      invoiceNumber: invoice.invoiceNumber,
      amountKobo,
      balanceKobo: Number(invoice.totalAmountKobo) - (paidSoFar + amountKobo),
    })

    response.status(201)
    return serialize(this.serializePayment(payment))
  }

  async listPayments({ school, request, serialize }: HttpContext) {
    const from = request.input('from')
    const to = request.input('to')
    const method = request.input('method')

    const query = Payment.query()
      .where('school_id', school.id)
      .preload('student')
      .preload('invoice')
      .preload('recordedBy')
      .orderBy('paid_at', 'desc')
      .limit(500)

    if (from) query.where('paid_at', '>=', String(from))
    if (to) query.where('paid_at', '<=', String(to))
    if (method) query.where('method', String(method))

    const rows = await query
    const totalKobo = rows.reduce((s, p) => s + Number(p.amountKobo), 0)
    return serialize({ rows: rows.map((r) => this.serializePayment(r)), totalKobo })
  }

  /**
   * POST /schools/:sid/invoices - manual (ad-hoc) invoice for one student.
   * Items are free-form, not tied to a fee structure.
   */
  async createInvoice({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createManualInvoiceValidator)
    const student = await Student.query()
      .where('id', payload.studentId)
      .where('school_id', school.id)
      .first()
    if (!student) return response.notFound({ message: 'Student not found' })

    const totalKobo = payload.items.reduce((s, i) => s + toKobo(i.amount), 0)
    const invoice = await db.transaction(async (trx) => {
      const inv = await FeeInvoice.create(
        {
          schoolId: school.id,
          studentId: payload.studentId,
          termId: payload.termId,
          feeStructureId: null,
          invoiceNumber: await this.nextInvoiceNumber(school.id, trx),
          totalAmountKobo: totalKobo,
          status: 'pending' as InvoiceStatus,
          issuedOn: DateTime.now(),
          dueOn: payload.dueOn ? DateTime.fromISO(payload.dueOn) : null,
          notes: payload.notes ?? null,
        },
        { client: trx }
      )
      for (const item of payload.items) {
        await FeeInvoiceItem.create(
          {
            invoiceId: inv.id,
            description: item.description,
            amountKobo: toKobo(item.amount),
          },
          { client: trx }
        )
      }
      return inv
    })

    await invoice.load('student')
    await invoice.load('term')
    await invoice.load('items')
    await invoice.load('payments')

    await notifyInvoiceIssued({
      schoolId: school.id,
      studentId: payload.studentId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalKobo: totalKobo,
      dueOn: payload.dueOn ?? null,
    })

    response.status(201)
    return serialize(this.serializeInvoice(invoice, true))
  }

  /**
   * POST /schools/:sid/payments/bulk - same amount + method against each
   * selected student's oldest outstanding invoice. Skips students who have
   * no outstanding balance and reports them back.
   */
  async recordBulkPayment({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(bulkPaymentValidator)
    const amountKobo = toKobo(payload.amount)
    if (amountKobo <= 0) return response.badRequest({ message: 'Amount must be positive' })

    const paidAt = payload.paidAt ? DateTime.fromISO(payload.paidAt) : DateTime.now()
    const results: {
      recorded: {
        studentId: number
        invoiceId: number
        invoiceNumber: string
        amountApplied: number
      }[]
      skipped: { studentId: number; reason: string }[]
    } = { recorded: [], skipped: [] }

    await db.transaction(async (trx) => {
      for (const sid of payload.studentIds) {
        const stu = await Student.query({ client: trx })
          .where('id', sid)
          .where('school_id', school.id)
          .first()
        if (!stu) {
          results.skipped.push({ studentId: sid, reason: 'Not found' })
          continue
        }
        const invoices = await FeeInvoice.query({ client: trx })
          .where('school_id', school.id)
          .where('student_id', sid)
          .whereNotIn('status', ['paid', 'cancelled'])
          .preload('payments')
          .orderBy('issued_on', 'asc')
        const target = invoices.find((inv) => {
          const paid = inv.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
          return Number(inv.totalAmountKobo) - paid > 0
        })
        if (!target) {
          results.skipped.push({ studentId: sid, reason: 'No outstanding invoice' })
          continue
        }
        const paidSoFar = target.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
        const outstanding = Number(target.totalAmountKobo) - paidSoFar
        const apply = Math.min(amountKobo, outstanding)
        await Payment.create(
          {
            schoolId: school.id,
            invoiceId: target.id,
            studentId: sid,
            amountKobo: apply,
            method: payload.method,
            reference: payload.reference ?? null,
            notes: payload.notes ?? null,
            paidAt,
            recordedByUserId: auth.getUserOrFail().id,
          },
          { client: trx }
        )
        const newPaid = paidSoFar + apply
        target.useTransaction(trx)
        target.status =
          newPaid >= Number(target.totalAmountKobo)
            ? 'paid'
            : newPaid > 0
              ? 'partial'
              : 'pending'
        await target.save()

        results.recorded.push({
          studentId: sid,
          invoiceId: target.id,
          invoiceNumber: target.invoiceNumber,
          amountApplied: apply,
        })
      }
    })

    return serialize(results)
  }

  /* ==================== helpers ==================== */
  private async nextInvoiceNumber(
    schoolId: number,
    trx: TransactionClientContract
  ): Promise<string> {
    const rowCount = await FeeInvoice.query({ client: trx })
      .where('school_id', schoolId)
      .count('* as total')
    const n = Number(rowCount[0].$extras.total) + 1
    const year = new Date().getFullYear()
    return `INV-${year}-${String(n).padStart(5, '0')}`
  }

  private serializeStructure(row: FeeStructure) {
    const totalKobo = row.items.reduce((s, i) => s + Number(i.amountKobo), 0)
    return {
      id: row.id,
      name: row.name,
      classId: row.classId,
      classIds: row.classIds ?? (row.classId ? [row.classId] : null),
      class: row.schoolClass ? { id: row.schoolClass.id, name: row.schoolClass.name } : null,
      termId: row.termId,
      term: row.term
        ? { id: row.term.id, session: row.term.session, name: row.term.name }
        : null,
      items: row.items.map((i) => ({
        id: i.id,
        description: i.description,
        amountKobo: Number(i.amountKobo),
        amountNaira: Number(i.amountKobo) / 100,
        isOptional: i.isOptional,
      })),
      totalKobo,
      totalNaira: totalKobo / 100,
    }
  }

  private serializeInvoice(row: FeeInvoice, withDetail = false) {
    const paidKobo = row.payments?.reduce((s, p) => s + Number(p.amountKobo), 0) ?? 0
    const totalKobo = Number(row.totalAmountKobo)
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      studentId: row.studentId,
      student: row.student
        ? {
            id: row.student.id,
            fullName: [row.student.firstName, row.student.lastName].filter(Boolean).join(' '),
            admissionNumber: row.student.admissionNumber,
          }
        : null,
      term: row.term
        ? { id: row.term.id, session: row.term.session, name: row.term.name }
        : null,
      totalKobo,
      totalNaira: totalKobo / 100,
      paidKobo,
      paidNaira: paidKobo / 100,
      outstandingKobo: totalKobo - paidKobo,
      outstandingNaira: (totalKobo - paidKobo) / 100,
      status: row.status,
      issuedOn: row.issuedOn?.toISODate?.() ?? row.issuedOn,
      dueOn: row.dueOn?.toISODate?.() ?? row.dueOn,
      ...(withDetail
        ? {
            items:
              row.items?.map((i) => ({
                id: i.id,
                description: i.description,
                amountKobo: Number(i.amountKobo),
              })) ?? [],
            payments:
              row.payments?.map((p) => this.serializePayment(p)) ?? [],
          }
        : {}),
    }
  }

  private serializePayment(row: Payment) {
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      studentId: row.studentId,
      student: row.student
        ? {
            id: row.student.id,
            fullName: [row.student.firstName, row.student.lastName].filter(Boolean).join(' '),
            admissionNumber: row.student.admissionNumber,
          }
        : null,
      invoiceNumber: row.invoice?.invoiceNumber ?? null,
      amountKobo: Number(row.amountKobo),
      amountNaira: Number(row.amountKobo) / 100,
      method: row.method,
      reference: row.reference,
      notes: row.notes,
      paidAt: row.paidAt,
      recordedBy: row.recordedBy
        ? { id: row.recordedBy.id, fullName: row.recordedBy.fullName, email: row.recordedBy.email }
        : null,
    }
  }
}
