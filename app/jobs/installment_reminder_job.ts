import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { BaseJob } from '#jobs/base_job'
import FeeInvoice from '#models/fee_invoice'
import InvoiceInstallment from '#models/invoice_installment'
import db from '@adonisjs/lucid/services/db'
import { scheduleState } from '#services/installments'
import { fireAutomation } from '#services/automations'

const naira = (k: number) => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })

/**
 * Daily at 08:00 Lagos (see worker.ts). For every instalment still owing,
 * remind guardians three days before it is due and once the day after it
 * is missed. Each reminder is deduped per instalment, so re-runs are safe.
 * Schools only get messages if they switched the alert on.
 */
export default class InstallmentReminderJob extends BaseJob<Record<string, never>> {
  static queueName = 'default'
  static jobName = 'installment_reminder'
  static repeatKey = 'installment-reminder-daily'

  async handle() {
    const today = DateTime.now().setZone('Africa/Lagos').startOf('day')
    const soon = today.plus({ days: 3 }).toISODate()!
    const missed = today.minus({ days: 1 }).toISODate()!
    const rows = await InvoiceInstallment.query().whereIn('due_on', [soon, missed])
    if (!rows.length) return
    const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))]
    const invoices = await FeeInvoice.query().whereIn('id', invoiceIds).whereNotIn('status', ['cancelled', 'paid'])
    const all = await InvoiceInstallment.query().whereIn('invoice_id', invoiceIds)
    const paidRows = await db.from('payments').whereIn('invoice_id', invoiceIds).groupBy('invoice_id').select('invoice_id').sum('amount_kobo as t')
    const paid = new Map((paidRows as any[]).map((r) => [r.invoice_id, Number(r.t)]))

    let sent = 0
    for (const inv of invoices) {
      const states = scheduleState(
        all.filter((r) => r.invoiceId === inv.id),
        paid.get(inv.id) ?? 0,
        today.toISODate()!
      )
      for (const s of states) {
        if (s.remainingKobo <= 0 || (s.dueOn !== soon && s.dueOn !== missed)) continue
        const late = s.dueOn === missed
        const due = DateTime.fromISO(s.dueOn).toFormat('d LLL yyyy')
        await fireAutomation(inv.schoolId, 'installment', {
          studentId: inv.studentId,
          vars: {
            label: s.label,
            amount: naira(s.remainingKobo),
            due_date: due,
            when: late ? `now overdue (it was due ${due})` : `due on ${due}`,
          },
          dedupeKey: `installment:${late ? 'late' : 'soon'}:${s.id}`,
        })
        sent++
      }
    }
    logger.info({ sent }, 'instalment reminders checked')
  }
}
