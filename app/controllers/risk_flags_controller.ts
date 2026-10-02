import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import StudentRiskFlag, { type RiskSignal } from '#models/student_risk_flag'
import User from '#models/user'
import { teacherScope, type TeacherScope } from '#services/teacher_scope'
import { scanSchool } from '#services/risk_scan'

/**
 * Early warning list. Admins see every flag (including fee signals);
 * teachers see only students in classes they are class teacher of, with
 * admin-only signals removed and the level recomputed from what they see.
 */
export default class RiskFlagsController {
  private visible(flag: StudentRiskFlag, scope: TeacherScope) {
    const signals: RiskSignal[] = scope.unscoped ? flag.signals : flag.signals.filter((s) => !s.adminOnly)
    const score = signals.reduce((t, s) => t + s.weight, 0)
    const level = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low'
    return { signals, score, level }
  }

  private async scopedFlags(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const scope = await teacherScope(user, ctx.school.id)
    const q = StudentRiskFlag.query()
      .where('school_id', ctx.school.id)
      .preload('student')
      .preload('schoolClass')
    if (!scope.unscoped) q.whereIn('class_id', scope.classTeacherOf.length ? scope.classTeacherOf : [0])
    const rows = await q
    const items = rows
      .map((f) => ({ f, v: this.visible(f, scope) }))
      .filter((x) => x.v.signals.length > 0)
    return { scope, items }
  }

  /** GET /risk-flags?level=&status=&classId= */
  async index(ctx: HttpContext) {
    const { scope, items } = await this.scopedFlags(ctx)
    const level = ctx.request.input('level')
    const status = ctx.request.input('status')
    const classId = Number(ctx.request.input('classId')) || null

    const reviewerIds = [...new Set(items.map((x) => x.f.reviewedByUserId).filter((x): x is number => !!x))]
    const reviewers = reviewerIds.length ? await User.query().whereIn('id', reviewerIds) : []
    const reviewerName = new Map(reviewers.map((u) => [u.id, u.fullName ?? u.email]))

    const order = { high: 0, medium: 1, low: 2 } as Record<string, number>
    const filtered = items
      .filter((x) => (!level || x.v.level === level) && (!status || x.f.status === status))
      .filter((x) => !classId || x.f.classId === classId)
      .sort((a, b) => order[a.v.level] - order[b.v.level] || b.v.score - a.v.score)

    const open = items.filter((x) => x.f.status === 'open')
    const lastScan = items.reduce<DateTime | null>(
      (m, x) => (!m || x.f.computedAt > m ? x.f.computedAt : m),
      null
    )
    return ctx.serialize({
      canScan: scope.unscoped,
      lastScanAt: lastScan,
      counts: {
        high: open.filter((x) => x.v.level === 'high').length,
        medium: open.filter((x) => x.v.level === 'medium').length,
        low: open.filter((x) => x.v.level === 'low').length,
        reviewed: items.length - open.length,
      },
      flags: filtered.map(({ f, v }) => ({
        id: f.id,
        student: {
          id: f.studentId,
          fullName: f.student ? [f.student.firstName, f.student.lastName].filter(Boolean).join(' ') : null,
          admissionNumber: f.student?.admissionNumber ?? null,
          photoUrl: f.student?.photoUrl ?? null,
        },
        class: f.schoolClass ? { id: f.schoolClass.id, name: f.schoolClass.name } : null,
        level: v.level,
        score: v.score,
        signals: v.signals.map((s) => ({ kind: s.kind, label: s.label, detail: s.detail, adminOnly: !!s.adminOnly })),
        summary: f.summary,
        suggestedAction: f.suggestedAction,
        status: f.status,
        reviewedBy: f.reviewedByUserId ? (reviewerName.get(f.reviewedByUserId) ?? null) : null,
        reviewedAt: f.reviewedAt,
        reviewNote: f.reviewNote,
        computedAt: f.computedAt,
      })),
    })
  }

  /** GET /risk-flags/summary - open medium/high counts for dashboards. */
  async summary(ctx: HttpContext) {
    const { items } = await this.scopedFlags(ctx)
    const open = items.filter((x) => x.f.status === 'open')
    return ctx.serialize({
      high: open.filter((x) => x.v.level === 'high').length,
      medium: open.filter((x) => x.v.level === 'medium').length,
    })
  }

  /** POST /risk-flags/scan - admin runs the scan now. */
  async scan(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const scope = await teacherScope(user, ctx.school.id)
    if (!scope.unscoped) return ctx.response.forbidden({ message: 'Only admins can run the scan.' })
    const stats = await scanSchool(ctx.school.id, { withAi: true })
    return ctx.serialize(stats)
  }

  private async findForUpdate(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const scope = await teacherScope(user, ctx.school.id)
    const flag = await StudentRiskFlag.query()
      .where('id', Number(ctx.params.id))
      .where('school_id', ctx.school.id)
      .first()
    if (!flag) {
      ctx.response.notFound({ message: 'Flag not found' })
      return null
    }
    if (!scope.unscoped && !(flag.classId && scope.classTeacherOf.includes(flag.classId))) {
      ctx.response.forbidden({ message: 'Only the class teacher or an admin can update this.' })
      return null
    }
    // A teacher cannot act on a flag made only of signals hidden from them
    // (e.g. fees); answer as if it does not exist.
    if (this.visible(flag, scope).signals.length === 0) {
      ctx.response.notFound({ message: 'Flag not found' })
      return null
    }
    return { user, flag }
  }

  /** POST /risk-flags/:id/review { note? } - mark as followed up. */
  async review(ctx: HttpContext) {
    const found = await this.findForUpdate(ctx)
    if (!found) return
    const note = String(ctx.request.input('note') ?? '').trim().slice(0, 1000) || null
    found.flag.merge({
      status: 'reviewed',
      reviewedByUserId: found.user.id,
      reviewedAt: DateTime.now(),
      reviewNote: note,
    })
    await found.flag.save()
    return ctx.serialize({ ok: true })
  }

  /** POST /risk-flags/:id/reopen */
  async reopen(ctx: HttpContext) {
    const found = await this.findForUpdate(ctx)
    if (!found) return
    found.flag.merge({ status: 'open', reviewedByUserId: null, reviewedAt: null, reviewNote: null })
    await found.flag.save()
    return ctx.serialize({ ok: true })
  }
}
