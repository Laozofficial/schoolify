import type User from '#models/user'
import Student from '#models/student'

/**
 * The students a family member may ask about: a student's own record plus,
 * for parents, their linked wards. Deliberately ignores staff roles - the
 * family assistant must never widen to "every student in the school" just
 * because the user also happens to be staff.
 */
export interface FamilyAccess {
  students: Student[]
  isParent: boolean
  isStudent: boolean
  /** Ids of students who are the caller's wards (parent relationship). */
  wardIds: Set<number>
}

export async function familyAccess(user: User, schoolId: number): Promise<FamilyAccess> {
  const roles = await user.rolesAtSchool(schoolId)
  const isParent = roles.includes('parent')
  const isStudent = roles.includes('student')

  const byId = new Map<number, Student>()
  const wardIds = new Set<number>()

  if (isStudent) {
    const self = await Student.query()
      .where('school_id', schoolId)
      .where('user_id', user.id)
      .where('is_archived', false)
      .preload('schoolClass')
    for (const s of self) byId.set(s.id, s)
  }
  if (isParent) {
    const wards = await user
      .related('wards')
      .query()
      .where('students.school_id', schoolId)
      .where('students.is_archived', false)
      .preload('schoolClass')
    for (const w of wards) {
      byId.set(w.id, w)
      wardIds.add(w.id)
    }
  }
  const students = [...byId.values()].sort((a, b) => a.firstName.localeCompare(b.firstName))
  return { students, isParent, isStudent, wardIds }
}
