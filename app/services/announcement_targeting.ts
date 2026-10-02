import type { Role } from '#models/user_school_role'
import User from '#models/user'
import UserSchoolRole from '#models/user_school_role'
import ParentStudent from '#models/parent_student'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import TimetableSlot from '#models/timetable_slot'

/* ---------- Rule types ---------- */

export type TargetRule =
  | { type: 'role'; role: Role }
  | { type: 'role_in_class'; role: 'parent' | 'student' | 'teacher'; classId: number }
  | { type: 'teachers_of_subject'; subjectId: number }
  | { type: 'users'; userIds: number[] }

/**
 * Everything about the caller needed to evaluate any rule, gathered once per
 * request. Empty/zero arrays for people who have no such relation.
 */
export interface CallerContext {
  userId: number
  roles: Role[]
  /** Class this user is enrolled in (if they are a student). */
  studentClassId: number | null
  /** Classes this user parents (via parent_students → students.class_id). */
  wardClassIds: number[]
  /** Classes this user teaches: as class_teacher or via timetable slots. */
  teacherClassIds: number[]
  /** Subjects this user teaches (via timetable slots). */
  teacherSubjectIds: number[]
}

/**
 * Build a CallerContext for `user` at `schoolId`. Runs a small handful of
 * queries; safe to compute once per request.
 */
export async function buildCallerContext(
  user: User,
  schoolId: number
): Promise<CallerContext> {
  const roleRows = await UserSchoolRole.query()
    .where('user_id', user.id)
    .where('school_id', schoolId)
  const roles = roleRows.map((r) => r.role as Role)

  // student class
  let studentClassId: number | null = null
  if (roles.includes('student')) {
    const s = await Student.query()
      .where('user_id', user.id)
      .where('school_id', schoolId)
      .first()
    studentClassId = s?.classId ?? null
  }

  // parent → ward classes
  let wardClassIds: number[] = []
  if (roles.includes('parent')) {
    const links = await ParentStudent.query()
      .where('parent_user_id', user.id)
      .preload('student', (q) => q.where('school_id', schoolId))
    wardClassIds = Array.from(
      new Set(
        links
          .map((l) => l.student?.classId)
          .filter((id): id is number => typeof id === 'number')
      )
    )
  }

  // teacher → classes as class-teacher + classes touched by their timetable slots
  let teacherClassIds: number[] = []
  let teacherSubjectIds: number[] = []
  if (roles.includes('teacher')) {
    const [asClassTeacher, slots] = await Promise.all([
      SchoolClass.query().where('school_id', schoolId).where('class_teacher_id', user.id),
      TimetableSlot.query().where('school_id', schoolId).where('teacher_id', user.id),
    ])
    teacherClassIds = Array.from(
      new Set([
        ...asClassTeacher.map((c) => c.id),
        ...slots.map((s) => s.classId),
      ])
    )
    teacherSubjectIds = Array.from(
      new Set(
        slots
          .map((s) => s.subjectId)
          .filter((id): id is number => typeof id === 'number')
      )
    )
  }

  return { userId: user.id, roles, studentClassId, wardClassIds, teacherClassIds, teacherSubjectIds }
}

/**
 * True if any rule matches the caller. An empty/missing rule set means the
 * announcement is untargeted (visible to everyone) - that's the caller's
 * responsibility to check before invoking this.
 */
export function callerMatchesAnyRule(ctx: CallerContext, rules: TargetRule[]): boolean {
  return rules.some((r) => matchOne(ctx, r))
}

function matchOne(ctx: CallerContext, rule: TargetRule): boolean {
  switch (rule.type) {
    case 'role':
      return ctx.roles.includes(rule.role)
    case 'role_in_class':
      if (!ctx.roles.includes(rule.role)) return false
      if (rule.role === 'student') return ctx.studentClassId === rule.classId
      if (rule.role === 'parent') return ctx.wardClassIds.includes(rule.classId)
      if (rule.role === 'teacher') return ctx.teacherClassIds.includes(rule.classId)
      return false
    case 'teachers_of_subject':
      return ctx.roles.includes('teacher') && ctx.teacherSubjectIds.includes(rule.subjectId)
    case 'users':
      return rule.userIds.includes(ctx.userId)
    default:
      return false
  }
}
