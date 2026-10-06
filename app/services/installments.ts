import { DateTime } from 'luxon'
import type InvoiceInstallment from '#models/invoice_installment'

/**
 * Instalment status is never stored: payments are applied to instalments in
 * due-date order, so the schedule always agrees with what was actually paid.
 */

export interface InstallmentState {
  id: number
  position: number
  label: string
  dueOn: string
  amountKobo: number
  paidKobo: number
  remainingKobo: number
  status: 'paid' | 'partial' | 'due' | 'overdue' | 'upcoming'
}

const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0

export function scheduleState(rows: InvoiceInstallment[], paidKobo: number, today = DateTime.now().setZone('Africa/Lagos').toISODate()!): InstallmentState[] {
  let left = Math.max(0, paidKobo)
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const amount = n(r.amountKobo)
      const paid = Math.min(left, amount)
      left -= paid
      const remaining = amount - paid
      const due = r.dueOn.toISODate()!
      const soon = DateTime.fromISO(due).diff(DateTime.fromISO(today), 'days').days <= 7
      const status: InstallmentState['status'] =
        remaining === 0 ? 'paid' : due < today ? 'overdue' : paid > 0 ? 'partial' : soon ? 'due' : 'upcoming'
      return {
        id: r.id,
        position: r.position,
        label: r.label ?? `Instalment ${r.position}`,
        dueOn: due,
        amountKobo: amount,
        paidKobo: paid,
        remainingKobo: remaining,
        status,
      }
    })
}

/** Split a total into N parts; any rounding remainder goes on the first. */
export function splitEven(totalKobo: number, parts: number): number[] {
  const base = Math.floor(totalKobo / parts)
  const out = Array.from({ length: parts }, () => base)
  out[0] += totalKobo - base * parts
  return out
}
