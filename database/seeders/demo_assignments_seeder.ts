import { BaseSeeder } from '@adonisjs/lucid/seeders'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import Assignment from '#models/assignment'
import TeacherSubject from '#models/teacher_subject'

/**
 * Seeds a couple of published assignments per class (one already due, one
 * upcoming) so student submissions can be tested end to end. Idempotent -
 * matches on (schoolId, classId, title).
 *
 * Run: node ace db:seed --files ./database/seeders/demo_assignments_seeder.ts
 */
export default class extends BaseSeeder {
  async run() {
    const school = await School.findBy('slug', 'demo-academy')
    if (!school) {
      logger.warn('demo-academy not found; run the demo seeder first')
      return
    }

    const classes = await SchoolClass.query()
      .where('school_id', school.id)
      .preload('subjects')

    let created = 0
    for (const cls of classes) {
      const subjects = cls.subjects.slice(0, 2)
      if (subjects.length === 0) continue

      for (const [i, subject] of subjects.entries()) {
        // Prefer a teacher assigned to this subject in this class; fall back
        // to the class teacher.
        const ts = await TeacherSubject.query()
          .where('class_id', cls.id)
          .where('subject_id', subject.id)
          .first()
        const teacherId = ts?.userId ?? cls.classTeacherId ?? null

        const specs = [
          {
            title: `${subject.name} - Homework 1`,
            deadline: DateTime.now().minus({ days: 3 }),
            description: `Complete the exercises for ${subject.name}. Submit your work here.`,
          },
          {
            title: `${subject.name} - Project`,
            deadline: DateTime.now().plus({ days: 7 }),
            description: `A short project on ${subject.name}. Attach your document or type your answer.`,
          },
        ]
        // Stagger so each class gets both, but only for the first subject to
        // avoid flooding: subject 0 gets both, subject 1 gets the project.
        const chosen = i === 0 ? specs : specs.slice(1)

        for (const spec of chosen) {
          const row = await Assignment.updateOrCreate(
            { schoolId: school.id, classId: cls.id, title: spec.title },
            {
              subjectId: subject.id,
              teacherId,
              description: spec.description,
              deadline: spec.deadline,
              maxScore: 20,
              published: true,
            }
          )
          if (row.$isLocal) created += 1
        }
      }
    }

    logger.info(`Seeded assignments across ${classes.length} classes (~${created} new).`)
  }
}
