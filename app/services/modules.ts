import type School from '#models/school'

/**
 * Optional modules a school can switch off. Everything is on by default;
 * a school that does not use a feature can hide it from every menu, and
 * the API refuses its routes.
 */
export const MODULES = [
  { key: 'messaging', label: 'Messages and alerts', description: 'SMS, email and WhatsApp to families and staff, plus automatic alerts.' },
  { key: 'gate', label: 'Gate and staff check-in', description: 'QR ID cards, gate scanning, staff phone check-in and the daily command centre.' },
  { key: 'pickup', label: 'Child pickup', description: 'Daily pickup codes, approved collectors and the pickup log.' },
  { key: 'visitors', label: 'Visitors', description: 'Front-desk visitor sign-in.' },
  { key: 'leave', label: 'Leave requests', description: 'Staff leave applications and approvals.' },
  { key: 'payroll', label: 'Payroll', description: 'Staff pay, monthly payroll runs and payslips.' },
  { key: 'inventory', label: 'Inventory', description: 'Store items, purchases, suppliers and stock issuing.' },
  { key: 'cbt', label: 'Exams and CBT', description: 'Teacher-set objective exams taken online.' },
  { key: 'ai', label: 'AI assistant and copilot', description: 'Family assistant, admin copilot, AI drafting and the early warning list.' },
] as const

export type ModuleKey = (typeof MODULES)[number]['key']

export function enabledModules(school: Pick<School, 'settings'>): Record<ModuleKey, boolean> {
  const raw = ((school.settings ?? {}) as any).modules ?? {}
  const out = {} as Record<ModuleKey, boolean>
  for (const m of MODULES) out[m.key] = raw[m.key] !== false
  return out
}
