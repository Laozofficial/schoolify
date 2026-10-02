import vine from '@vinejs/vine'

const staffRoleValidator = vine.enum([
  'admin',
  'teacher',
  'non_academic_staff',
  'accountant',
] as const)

export const createStaffValidator = vine.compile(
  vine.object({
    email: vine.string().trim().email(),
    fullName: vine.string().trim().minLength(1).maxLength(160),
    surname: vine.string().trim().minLength(1).maxLength(80),
    phone: vine.string().trim().maxLength(32).optional(),
    roles: vine.array(staffRoleValidator).minLength(1),
  })
)

export const updateStaffRolesValidator = vine.compile(
  vine.object({
    roles: vine.array(staffRoleValidator).minLength(1),
  })
)

/**
 * Teaching load - the set of (class, subject) a teacher is qualified
 * to teach. Used both for scoping "which teachers can enter scores for
 * this class/subject" and to drive timetable auto-generation.
 */
export const setTeacherSubjectsValidator = vine.compile(
  vine.object({
    items: vine.array(
      vine.object({
        classId: vine.number().positive(),
        subjectId: vine.number().positive(),
      })
    ),
  })
)
