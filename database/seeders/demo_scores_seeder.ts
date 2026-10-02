import { BaseSeeder } from '@adonisjs/lucid/seeders'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import School from '#models/school'
import Student from '#models/student'
import Assessment from '#models/assessment'
import Score from '#models/score'
import Term from '#models/term'
import User from '#models/user'
import ReportApproval from '#models/report_approval'
import SchoolClass from '#models/school_class'

/**
 * Seeds realistic scores for every active student across their class
 * subjects and every assessment, for the current term, then approves the
 * reports so students + parents can view report cards. Idempotent -
 * Score.updateOrCreate on the natural key.
 *
 * Run: node ace db:seed --files ./database/seeders/demo_scores_seeder.ts
 */
export default class extends BaseSeeder {
  async run() {
    const school = await School.findBy('slug', 'demo-academy')
    if (!school) {
      logger.warn('demo-academy not found; run the demo seeder first')
      return
    }
    const term = await Term.query()
      .where('school_id', school.id)
      .where('is_current', true)
      .first()
    if (!term) {
      logger.warn('No current term set; nothing to seed')
      return
    }

    // A fresh install has no assessments yet: create the usual Nigerian
    // split (two continuous assessments + exam) so scores can be seeded.
    if (!(await Assessment.query().where('school_id', school.id).first())) {
      const defaults = [
        { name: 'CA 1', weight: 20, maxScore: 20 },
        { name: 'CA 2', weight: 20, maxScore: 20 },
        { name: 'Exam', weight: 60, maxScore: 60 },
      ]
      for (const [i, d] of defaults.entries()) {
        await Assessment.create({ schoolId: school.id, ...d, orderIndex: i })
      }
    }

    const [assessments, classes, admin] = await Promise.all([
      Assessment.query().where('school_id', school.id),
      SchoolClass.query().where('school_id', school.id).preload('subjects'),
      User.query()
        .whereHas('roleAssignments', (q) =>
          q.where('school_id', school.id).where('role', 'super_admin')
        )
        .first(),
    ])
    const subjectsByClass = new Map(classes.map((c) => [c.id, c.subjects]))

    const students = await Student.query()
      .where('school_id', school.id)
      .where('is_archived', false)

    // Deterministic-ish score per (student, subject, assessment) so re-runs
    // are stable: seeded from ids, banded 45-95% of maxScore.
    const scoreFor = (sid: number, subId: number, aId: number, max: number) => {
      const seed = (sid * 31 + subId * 17 + aId * 7) % 51 // 0..50
      const pct = 45 + seed // 45..95
      return Math.round((pct / 100) * max)
    }

    let scoreCount = 0
    for (const student of students) {
      if (!student.classId) continue
      const subjects = subjectsByClass.get(student.classId) ?? []
      for (const subject of subjects) {
        for (const a of assessments) {
          await Score.updateOrCreate(
            {
              termId: term.id,
              studentId: student.id,
              subjectId: subject.id,
              assessmentId: a.id,
            },
            {
              score: String(scoreFor(student.id, subject.id, a.id, a.maxScore)),
              enteredByUserId: admin?.id ?? null,
            }
          )
          scoreCount += 1
        }
      }
    }

    // Approve every student's report for the term so the portal can show it.
    let approved = 0
    for (const student of students) {
      await ReportApproval.updateOrCreate(
        { termId: term.id, studentId: student.id },
        { approvedByUserId: admin?.id ?? null, approvedAt: DateTime.now() }
      )
      approved += 1
    }

    logger.info(
      `Seeded ${scoreCount} scores for ${students.length} students; approved ${approved} reports (term ${term.session} ${term.name}).`
    )
  }
}
