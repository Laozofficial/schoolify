import type User from '#models/user'
import SchoolClass from '#models/school_class'
import TeacherSubject from '#models/teacher_subject'

/**
 * Resolves what a user is allowed to touch at a school for teacher-scoped
 * endpoints (classes, timetable, attendance, results, assignments).
 *
 * - `super_admin` / `admin` bypass all scoping (`unscoped: true`).
 * - `teacher` sees only classes they are the class-teacher of PLUS classes
 *   they teach a subject in (via `teacher_subjects`). Score entry and
 *   attendance are also constrained here.
 * - Any other role gets an empty scope (attempts should be rejected by
 *   role middleware anyway, but this makes it safe if they aren't).
 */
export interface TeacherScope {
  unscoped: boolean
  /** class ids they are the pastoral class teacher of (attendance) */
  classTeacherOf: number[]
  /** union of classes they teach anything in (visibility) */
  classIds: number[]
  /** (classId, subjectId) pairs they may enter scores for */
  subjectPairs: Set<string>
}

export async function teacherScope(user: User, schoolId: number): Promise<TeacherScope> {
  const roles = await user.rolesAtSchool(schoolId)
  const unscoped = roles.some((r) => r === 'super_admin' || r === 'admin')
  if (unscoped) {
    return {
      unscoped: true,
      classTeacherOf: [],
      classIds: [],
      subjectPairs: new Set(),
    }
  }
  const isTeacher = roles.includes('teacher')
  if (!isTeacher) {
    return { unscoped: false, classTeacherOf: [], classIds: [], subjectPairs: new Set() }
  }

  const [tsRows, ctRows] = await Promise.all([
    TeacherSubject.query()
      .where('user_id', user.id)
      .whereIn(
        'class_id',
        SchoolClass.query().select('id').where('school_id', schoolId)
      ),
    SchoolClass.query()
      .where('school_id', schoolId)
      .where('class_teacher_id', user.id)
      .select('id'),
  ])
  const classTeacherOf = ctRows.map((c) => c.id)
  const classIds = Array.from(
    new Set<number>([...classTeacherOf, ...tsRows.map((r) => r.classId)])
  )
  const subjectPairs = new Set(tsRows.map((r) => `${r.classId}:${r.subjectId}`))
  return { unscoped: false, classTeacherOf, classIds, subjectPairs }
}

/** Convenience: is this (classId, subjectId) inside the teacher's scope? */
export function canTeachPair(scope: TeacherScope, classId: number, subjectId: number) {
  if (scope.unscoped) return true
  return scope.subjectPairs.has(`${classId}:${subjectId}`)
}

/** Convenience: is this class within the teacher's visible scope at all? */
export function canSeeClass(scope: TeacherScope, classId: number) {
  if (scope.unscoped) return true
  return scope.classIds.includes(classId)
}
