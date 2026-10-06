import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import FeeInvoice from '#models/fee_invoice'
import Payment from '#models/payment'
import { notifyPaymentRecorded } from '#services/notify'

/** Online payment references look like sch<schoolId>-inv<invoiceId>-<timestamp>. */
export function parseReference(reference: string): { schoolId: number; invoiceId: number } | null {
  const m = /^sch(\d+)-inv(\d+)-/.exec(reference)
  return m ? { schoolId: Number(m[1]), invoiceId: Number(m[2]) } : null
}

/**
 * Record a confirmed online payment against its invoice. Idempotent by
 * gateway reference, never applies more than the invoice still owes, and
 * locks the invoice so two webhooks for different references cannot both
 * read the same balance.
 */
export async function recordOnlinePayment(opts: { schoolId: number; invoiceId: number; reference: string; amountKobo: number }) {
  const result = await db.transaction(async (trx) => {
    const invoice = await FeeInvoice.query({ client: trx })
      .where('id', opts.invoiceId)
      .where('school_id', opts.schoolId)
      .forUpdate()
      .first()
    if (!invoice) return { status: 'invoice_missing' as const }
    const dup = await Payment.query({ client: trx }).where('reference', opts.reference).first()
    if (dup) return { status: 'duplicate' as const }
    const [row] = await trx.from('payments').where('invoice_id', invoice.id).sum('amount_kobo as t')
    const paidSoFar = Number((row as any)?.t ?? 0)
    const remaining = Number(invoice.totalAmountKobo) - paidSoFar
    const applied = remaining > 0 ? Math.min(opts.amountKobo, remaining) : opts.amountKobo
    await Payment.create(
      {
        schoolId: invoice.schoolId,
        invoiceId: invoice.id,
        studentId: invoice.studentId,
        amountKobo: applied,
        method: 'online',
        reference: opts.reference,
        paidAt: DateTime.now(),
        recordedByUserId: null,
      },
      { client: trx }
    )
    const newPaid = paidSoFar + applied
    invoice.status = newPaid >= Number(invoice.totalAmountKobo) ? 'paid' : newPaid > 0 ? 'partial' : 'pending'
    await invoice.useTransaction(trx).save()
    return { status: 'recorded' as const, invoice, applied, balance: Number(invoice.totalAmountKobo) - newPaid }
  })
  if (result.status === 'recorded') {
    await notifyPaymentRecorded({
      schoolId: result.invoice.schoolId,
      studentId: result.invoice.studentId,
      invoiceNumber: result.invoice.invoiceNumber,
      amountKobo: result.applied,
      balanceKobo: result.balance,
    })
  }
  return result.status
}
