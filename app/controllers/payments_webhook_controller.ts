import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import FeeInvoice from '#models/fee_invoice'
import Payment from '#models/payment'
import { verifyWebhookSignature, verifyPayment } from '#services/payment_gateway'
import { notifyPaymentRecorded } from '#services/notify'

/**
 * Public webhook for payment.twelveai.app. No auth middleware - it is
 * secured by the HMAC signature header instead. On a successful charge it
 * records a Payment against the encoded invoice (idempotent by gateway
 * reference) and updates the invoice status.
 */
export default class PaymentsWebhookController {
  async handle({ request, response }: HttpContext) {
    const raw = request.raw() ?? JSON.stringify(request.body())
    const signature =
      request.header('x-paystack-signature') ??
      request.header('x-twelveai-signature') ??
      request.header('x-signature') ??
      ''

    if (!verifyWebhookSignature(raw, signature)) {
      return response.unauthorized({ message: 'Invalid signature' })
    }

    const event = request.body() as any
    // MAP: adjust event name + payload path to the real gateway contract.
    const type = event?.event ?? event?.type
    const data = event?.data ?? event
    const reference: string = data?.reference ?? ''
    const isSuccess = type ? /success|charge\.success|paid/i.test(type) : false
    if (!isSuccess || !reference) {
      return response.ok({ received: true })
    }

    // reference format: sch<schoolId>-inv<invoiceId>-<ts>
    const m = /^sch(\d+)-inv(\d+)-/.exec(reference)
    if (!m) return response.ok({ received: true, note: 'unrecognized reference' })
    const invoiceId = Number(m[2])

    // Double-check with the gateway (defence against spoofed bodies).
    let amountKobo = Number(data?.amount ?? 0)
    try {
      const v = await verifyPayment(reference)
      if (v.status !== 'success') return response.ok({ received: true, note: 'not success' })
      amountKobo = v.amountKobo || amountKobo
    } catch {
      // If verify is unreachable, fall back to signed payload amount.
    }

    const invoice = await FeeInvoice.query()
      .where('id', invoiceId)
      .preload('payments')
      .first()
    if (!invoice) return response.ok({ received: true, note: 'invoice gone' })

    // Idempotency: ignore if we already recorded this gateway reference.
    const existing = await Payment.query().where('reference', reference).first()
    if (existing) return response.ok({ received: true, note: 'duplicate' })

    const paidSoFar = invoice.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
    const remaining = Number(invoice.totalAmountKobo) - paidSoFar
    const applied = Math.min(amountKobo, remaining > 0 ? remaining : amountKobo)

    await db.transaction(async (trx) => {
      await Payment.create(
        {
          schoolId: invoice.schoolId,
          invoiceId: invoice.id,
          studentId: invoice.studentId,
          amountKobo: applied,
          method: 'online',
          reference,
          paidAt: DateTime.now(),
          recordedByUserId: null,
        },
        { client: trx }
      )
      const newPaid = paidSoFar + applied
      invoice.useTransaction(trx)
      invoice.status =
        newPaid >= Number(invoice.totalAmountKobo)
          ? 'paid'
          : newPaid > 0
            ? 'partial'
            : 'pending'
      await invoice.save()
    })

    await notifyPaymentRecorded({
      schoolId: invoice.schoolId,
      studentId: invoice.studentId,
      invoiceNumber: invoice.invoiceNumber,
      amountKobo: applied,
      balanceKobo: Number(invoice.totalAmountKobo) - (paidSoFar + applied),
    })

    return response.ok({ received: true })
  }
}
