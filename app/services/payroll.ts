import type PayrollProfile from '#models/payroll_profile'
import type { PayslipLine } from '#models/payslip'

/**
 * Payslip arithmetic. All money is integer kobo. Pension is the employee's
 * share as a percentage of gross (basic plus allowances), rounded to the
 * nearest kobo. PAYE is a fixed monthly amount the school enters, because
 * statutory tax depends on reliefs we do not collect.
 */

export const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0

export function linesForProfile(p: PayrollProfile): PayslipLine[] {
  const lines: PayslipLine[] = [{ kind: 'earning', name: 'Basic salary', amountKobo: n(p.baseSalaryKobo) }]
  for (const a of p.allowances ?? []) {
    if (n(a.amountKobo) > 0) lines.push({ kind: 'earning', name: a.name, amountKobo: n(a.amountKobo) })
  }
  const gross = lines.reduce((t, l) => t + l.amountKobo, 0)
  const pct = Number(p.pensionPercent) || 0
  if (pct > 0) lines.push({ kind: 'deduction', name: `Pension (${pct}%)`, amountKobo: Math.round((gross * pct) / 100) })
  if (n(p.taxKobo) > 0) lines.push({ kind: 'deduction', name: 'PAYE tax', amountKobo: n(p.taxKobo) })
  for (const d of p.deductions ?? []) {
    if (n(d.amountKobo) > 0) lines.push({ kind: 'deduction', name: d.name, amountKobo: n(d.amountKobo) })
  }
  return lines
}

export function totals(lines: PayslipLine[]) {
  const gross = lines.filter((l) => l.kind === 'earning').reduce((t, l) => t + n(l.amountKobo), 0)
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((t, l) => t + n(l.amountKobo), 0)
  return { gross, deductions, net: gross - deductions }
}
