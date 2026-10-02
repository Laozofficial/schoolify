import logger from '@adonisjs/core/services/logger'
import { BaseJob } from '#jobs/base_job'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import User from '#models/user'
import StudentRiskFlag from '#models/student_risk_flag'
import { scanSchool } from '#services/risk_scan'
import { notifyUsers } from '#services/notify'

/**
 * Weekly early warning scan (Monday 07:00 Lagos, see worker.ts). Rescans
 * every school, then sends one in-app digest to the admins and one to each
 * class teacher whose class has open medium or high flags.
 */
export default class RiskScanJob extends BaseJob<{ schoolId?: number }> {
  static queueName = 'default'
  static jobName = 'risk_scan'
  static repeatKey = 'risk-scan-weekly'

  async handle(payload: { schoolId?: number }) {
    const schools = payload?.schoolId ? await School.query().where('id', payload.schoolId) : await School.all()
    for (const school of schools) {
      try {
        const stats = await scanSchool(school.id, { withAi: true })
        logger.info({ schoolId: school.id, ...stats }, 'risk scan complete')
        await this.notify(school.id)
      } catch (err) {
        logger.error({ err, schoolId: school.id }, 'risk scan failed')
      }
    }
  }

  private async notify(schoolId: number) {
    const flags = await StudentRiskFlag.query()
      .where('school_id', schoolId)
      .where('status', 'open')
      .whereIn('level', ['high', 'medium'])
    if (flags.length === 0) return

    const high = flags.filter((f) => f.level === 'high').length
    const admins = await User.query()
      .whereHas('roleAssignments', (r) => r.where('school_id', schoolId).whereIn('role', ['super_admin', 'admin']))
      .select('id')
    await notifyUsers(
      admins.map((u) => u.id),
      {
        schoolId,
        kind: 'risk_digest',
        title: `Early warning: ${flags.length} ${flags.length === 1 ? 'student needs' : 'students need'} attention`,
        body: `${high} high and ${flags.length - high} medium priority. Review them on the Early warning page.`,
        data: { kind: 'risk_digest', href: '/early-warning' },
      }
    )

    const byClass = new Map<number, number>()
    for (const f of flags) {
      // Teachers never see fee signals, so count by the score they see.
      const teacherScore = f.signals.filter((x) => !x.adminOnly).reduce((t, x) => t + x.weight, 0)
      if (f.classId && teacherScore >= 2) byClass.set(f.classId, (byClass.get(f.classId) ?? 0) + 1)
    }
    if (byClass.size === 0) return
    const classes = await SchoolClass.query().whereIn('id', [...byClass.keys()]).whereNotNull('class_teacher_id')
    for (const c of classes) {
      const n = byClass.get(c.id) ?? 0
      await notifyUsers([c.classTeacherId!], {
        schoolId,
        kind: 'risk_digest',
        title: `${n} ${n === 1 ? 'student' : 'students'} in ${c.name} ${n === 1 ? 'needs' : 'need'} attention`,
        body: 'See who, why, and a suggested next step on the Early warning page.',
        data: { kind: 'risk_digest', href: '/early-warning', classId: c.id },
      })
    }
  }
}
