import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import PayrollProfile from '#models/payroll_profile'
import PayrollRun from '#models/payroll_run'
import Payslip from '#models/payslip'
import { linesForProfile, n, totals } from '#services/payroll'
import { notifyUsers } from '#services/notify'
import { emitEvent } from '#services/events'
import { STAFF_ROLES } from '#services/gate'

const item = vine.object({ name: vine.string().trim().minLength(1).maxLength(80), amountKobo: vine.number().min(0).max(1e12) })

const profileValidator = vine.compile(
  vine.object({
    baseSalaryKobo: vine.number().min(0).max(1e12),
    allowances: vine.array(item).maxLength(20).optional(),
    deductions: vine.array(item).maxLength(20).optional(),
    pensionPercent: vine.number().min(0).max(50).optional(),
    taxKobo: vine.number().min(0).max(1e12).optional(),
    bankName: vine.string().trim().maxLength(120).nullable().optional(),
    accountNumber: vine.string().trim().regex(/^\d{6,20}$/).nullable().optional(),
    accountName: vine.string().trim().maxLength(160).nullable().optional(),
    active: vine.boolean().optional(),
  })
)

const runValidator = vine.compile(
  vine.object({ period: vine.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), notes: vine.string().trim().maxLength(1000).nullable().optional() })
)

const linesValidator = vine.compile(
  vine.object({
    lines: vine
      .array(
        vine.object({
          kind: vine.enum(['earning', 'deduction']),
          name: vine.string().trim().minLength(1).maxLength(80),
          amountKobo: vine.number().min(0).max(1e12),
        })
      )
      .minLength(1)
      .maxLength(40),
  })
)

function periodLabel(p: string) {
  return DateTime.fromFormat(p, 'yyyy-MM').toFormat('LLLL yyyy')
}

export default class PayrollController {
  /** Every staff member with their pay profile (or none yet). */
  async profiles({ school, serialize }: HttpContext) {
    const staff = await db
      .from('users as u')
      .join('user_school_roles as r', 'r.user_id', 'u.id')
      .where('r.school_id', school.id)
      .whereIn('r.role', [...STAFF_ROLES])
      .groupBy('u.id', 'u.full_name', 'u.email')
      .select('u.id', 'u.full_name', 'u.email', db.raw("string_agg(r.role, ',') as roles"))
      .orderBy('u.full_name')
    const profiles = await PayrollProfile.query().where('school_id', school.id)
    const byUser = new Map(profiles.map((p) => [p.userId, p]))
    return serialize(
      staff.map((s: any) => {
        const p = byUser.get(s.id)
        const t = p ? totals(linesForProfile(p)) : null
        return {
          userId: s.id,
          name: s.full_name ?? s.email,
          email: s.email,
          roles: String(s.roles).replace(/_/g, ' ').split(','),
          profile: p ? this.profileJson(p) : null,
          monthly: t,
        }
      })
    )
  }

  async saveProfile({ school, params, request, response, serialize }: HttpContext) {
    const userId = Number(params.userId)
    const isStaff = await db
      .from('user_school_roles')
      .where('school_id', school.id)
      .where('user_id', userId)
      .whereIn('role', [...STAFF_ROLES])
      .first()
    if (!isStaff) return response.notFound({ message: 'Staff member not found' })
    const p = await request.validateUsing(profileValidator)
    const row = await PayrollProfile.updateOrCreate(
      { schoolId: school.id, userId },
      {
        baseSalaryKobo: Math.round(p.baseSalaryKobo),
        allowances: (p.allowances ?? []).map((a) => ({ name: a.name, amountKobo: Math.round(a.amountKobo) })),
        deductions: (p.deductions ?? []).map((d) => ({ name: d.name, amountKobo: Math.round(d.amountKobo) })),
        pensionPercent: String(p.pensionPercent ?? 0),
        taxKobo: Math.round(p.taxKobo ?? 0),
        bankName: p.bankName ?? null,
        accountNumber: p.accountNumber ?? null,
        accountName: p.accountName ?? null,
        active: p.active ?? true,
      }
    )
    return serialize({ profile: this.profileJson(row), monthly: totals(linesForProfile(row)) })
  }

  async runs({ school, serialize }: HttpContext) {
    const rows = await PayrollRun.query().where('school_id', school.id).orderBy('period', 'desc')
    const counts = await db.from('payslips').where('school_id', school.id).groupBy('run_id').select('run_id').count('* as n')
    const byRun = new Map((counts as any[]).map((c) => [c.run_id, Number(c.n)]))
    return serialize(rows.map((r) => ({ ...this.runJson(r), staffCount: byRun.get(r.id) ?? 0 })))
  }

  /** Create a draft run for a month from every active pay profile. */
  async createRun({ school, auth, request, response, serialize }: HttpContext) {
    const p = await request.validateUsing(runValidator)
    const exists = await PayrollRun.query().where('school_id', school.id).where('period', p.period).first()
    if (exists) return response.conflict({ message: `There is already a payroll for ${periodLabel(p.period)}.`, id: exists.id })
    const run = await PayrollRun.create({
      schoolId: school.id,
      period: p.period,
      status: 'draft',
      notes: p.notes ?? null,
      createdByUserId: auth.user?.id ?? null,
    })
    await this.generate(run)
    response.status(201)
    return serialize(await this.runDetail(run))
  }

  async showRun({ school, params, response, serialize }: HttpContext) {
    const run = await PayrollRun.query().where('school_id', school.id).where('id', params.id).first()
    if (!run) return response.notFound({ message: 'Payroll not found' })
    return serialize(await this.runDetail(run))
  }

  /** Rebuild a draft from current profiles (discards one-off edits). */
  async regenerate({ school, params, response, serialize }: HttpContext) {
    const run = await PayrollRun.query().where('school_id', school.id).where('id', params.id).first()
    if (!run) return response.notFound({ message: 'Payroll not found' })
    if (run.status !== 'draft') return response.conflict({ message: 'Only a draft can be rebuilt.' })
    await Payslip.query().where('run_id', run.id).delete()
    await this.generate(run)
    return serialize(await this.runDetail(run))
  }

  /** One-off edits to a single payslip (bonus, overtime, a loan repayment). */
  async updatePayslip({ school, params, request, response, serialize }: HttpContext) {
    const slip = await Payslip.query().where('school_id', school.id).where('id', params.id).first()
    if (!slip) return response.notFound({ message: 'Payslip not found' })
    const run = await PayrollRun.findOrFail(slip.runId)
    if (run.status !== 'draft') return response.conflict({ message: 'This payroll is approved and locked.' })
    const { lines } = await request.validateUsing(linesValidator)
    const clean = lines.map((l) => ({ kind: l.kind, name: l.name, amountKobo: Math.round(l.amountKobo) }))
    const t = totals(clean)
    if (t.net < 0) return response.unprocessableEntity({ message: 'Deductions cannot be more than earnings.' })
    slip.merge({ lines: clean, grossKobo: t.gross, deductionsKobo: t.deductions, netKobo: t.net })
    await slip.save()
    await this.retotal(run)
    return serialize(await this.runDetail(run))
  }

  async removePayslip({ school, params, response, serialize }: HttpContext) {
    const slip = await Payslip.query().where('school_id', school.id).where('id', params.id).first()
    if (!slip) return response.notFound({ message: 'Payslip not found' })
    const run = await PayrollRun.findOrFail(slip.runId)
    if (run.status !== 'draft') return response.conflict({ message: 'This payroll is approved and locked.' })
    await slip.delete()
    await this.retotal(run)
    return serialize(await this.runDetail(run))
  }

  async approve({ school, auth, params, response, serialize }: HttpContext) {
    const run = await PayrollRun.query().where('school_id', school.id).where('id', params.id).first()
    if (!run) return response.notFound({ message: 'Payroll not found' })
    if (run.status !== 'draft') return response.conflict({ message: 'Already approved.' })
    const slips = await Payslip.query().where('run_id', run.id)
    if (!slips.length) return response.unprocessableEntity({ message: 'There are no payslips in this payroll.' })
    run.merge({ status: 'approved', approvedByUserId: auth.user?.id ?? null, approvedAt: DateTime.now() })
    await run.save()
    await emitEvent(school.id, 'payroll.approved', {
      runId: run.id,
      period: run.period,
      staffCount: slips.length,
      grossKobo: n(run.grossKobo),
      netKobo: n(run.netKobo),
    })
    for (const s of slips) {
      await notifyUsers([s.userId], {
        schoolId: school.id,
        kind: 'payslip',
        title: `Payslip for ${periodLabel(run.period)}`,
        body: `Your ${periodLabel(run.period)} payslip is ready. Net pay: ₦${(n(s.netKobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}.`,
        data: { kind: 'payslip', payslipId: s.id },
      })
    }
    return serialize(await this.runDetail(run))
  }

  async markPaid({ school, params, response, serialize }: HttpContext) {
    const run = await PayrollRun.query().where('school_id', school.id).where('id', params.id).first()
    if (!run) return response.notFound({ message: 'Payroll not found' })
    if (run.status !== 'approved') return response.conflict({ message: 'Approve the payroll before marking it paid.' })
    run.merge({ status: 'paid', paidAt: DateTime.now() })
    await run.save()
    return serialize(await this.runDetail(run))
  }

  async destroyRun({ school, params, response }: HttpContext) {
    const run = await PayrollRun.query().where('school_id', school.id).where('id', params.id).first()
    if (!run) return response.notFound({ message: 'Payroll not found' })
    if (run.status !== 'draft') return response.conflict({ message: 'Only a draft payroll can be deleted.' })
    await run.delete()
    return response.noContent()
  }

  /* ---------- staff self-service ---------- */

  async mine({ school, auth, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const slips = await db
      .from('payslips as s')
      .join('payroll_runs as r', 'r.id', 's.run_id')
      .where('s.school_id', school.id)
      .where('s.user_id', user.id)
      .whereIn('r.status', ['approved', 'paid'])
      .orderBy('r.period', 'desc')
      .select('s.id', 'r.period', 'r.status', 's.gross_kobo', 's.deductions_kobo', 's.net_kobo')
    return serialize(
      slips.map((s: any) => ({
        id: s.id,
        period: s.period,
        label: periodLabel(s.period),
        status: s.status,
        grossKobo: n(s.gross_kobo),
        deductionsKobo: n(s.deductions_kobo),
        netKobo: n(s.net_kobo),
      }))
    )
  }

  /** One payslip: its owner (approved runs only) or an admin. */
  async payslip({ school, auth, params, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const slip = await Payslip.query().where('school_id', school.id).where('id', params.id).first()
    if (!slip) return response.notFound({ message: 'Payslip not found' })
    const run = await PayrollRun.findOrFail(slip.runId)
    const roles = await user.rolesAtSchool(school.id)
    const isAdmin = roles.includes('super_admin') || roles.includes('admin')
    if (!isAdmin && (slip.userId !== user.id || run.status === 'draft')) return response.forbidden({ message: 'Not your payslip' })
    return serialize({ ...this.slipJson(slip), period: run.period, label: periodLabel(run.period), status: run.status, schoolName: school.name })
  }

  /* ---------- helpers ---------- */

  private async generate(run: PayrollRun) {
    const profiles = await PayrollProfile.query().where('school_id', run.schoolId).where('active', true).preload('user')
    for (const p of profiles) {
      const lines = linesForProfile(p)
      const t = totals(lines)
      if (t.gross <= 0) continue
      await Payslip.create({
        schoolId: run.schoolId,
        runId: run.id,
        userId: p.userId,
        staffName: p.user?.fullName ?? p.user?.email ?? 'Staff',
        lines,
        grossKobo: t.gross,
        deductionsKobo: t.deductions,
        netKobo: t.net,
        bankName: p.bankName,
        accountNumber: p.accountNumber,
        accountName: p.accountName,
      })
    }
    await this.retotal(run)
  }

  private async retotal(run: PayrollRun) {
    const [row] = await db
      .from('payslips')
      .where('run_id', run.id)
      .sum('gross_kobo as g')
      .sum('deductions_kobo as d')
      .sum('net_kobo as n')
    run.merge({ grossKobo: n((row as any).g), deductionsKobo: n((row as any).d), netKobo: n((row as any).n) })
    await run.save()
  }

  private async runDetail(run: PayrollRun) {
    const slips = await Payslip.query().where('run_id', run.id).orderBy('staff_name')
    return { ...this.runJson(run), staffCount: slips.length, payslips: slips.map((s) => this.slipJson(s)) }
  }

  private runJson(r: PayrollRun) {
    return {
      id: r.id,
      period: r.period,
      label: periodLabel(r.period),
      status: r.status,
      grossKobo: n(r.grossKobo),
      deductionsKobo: n(r.deductionsKobo),
      netKobo: n(r.netKobo),
      notes: r.notes,
      approvedAt: r.approvedAt,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }
  }

  private slipJson(s: Payslip) {
    return {
      id: s.id,
      userId: s.userId,
      staffName: s.staffName,
      lines: (s.lines ?? []).map((l) => ({ ...l, amountKobo: n(l.amountKobo) })),
      grossKobo: n(s.grossKobo),
      deductionsKobo: n(s.deductionsKobo),
      netKobo: n(s.netKobo),
      bankName: s.bankName,
      accountNumber: s.accountNumber,
      accountName: s.accountName,
    }
  }

  private profileJson(p: PayrollProfile) {
    return {
      baseSalaryKobo: n(p.baseSalaryKobo),
      allowances: (p.allowances ?? []).map((a) => ({ name: a.name, amountKobo: n(a.amountKobo) })),
      deductions: (p.deductions ?? []).map((d) => ({ name: d.name, amountKobo: n(d.amountKobo) })),
      pensionPercent: Number(p.pensionPercent) || 0,
      taxKobo: n(p.taxKobo),
      bankName: p.bankName,
      accountNumber: p.accountNumber,
      accountName: p.accountName,
      active: p.active,
    }
  }
}
