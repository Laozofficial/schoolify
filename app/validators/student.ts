import vine from '@vinejs/vine'

const extras = {
  phone: vine.string().trim().maxLength(32).nullable().optional(),
  email: vine.string().trim().email().nullable().optional(),
  address: vine.string().trim().maxLength(1000).nullable().optional(),
  bloodGroup: vine.string().trim().maxLength(8).nullable().optional(),
  allergies: vine.string().trim().maxLength(2000).nullable().optional(),
  previousSchool: vine.string().trim().maxLength(200).nullable().optional(),
  religion: vine.string().trim().maxLength(60).nullable().optional(),
  homeLanguage: vine.string().trim().maxLength(60).nullable().optional(),
  emergencyContactName: vine.string().trim().maxLength(200).nullable().optional(),
  emergencyContactPhone: vine.string().trim().maxLength(32).nullable().optional(),
}

export const createStudentValidator = vine.compile(
  vine.object({
    admissionNumber: vine.string().trim().minLength(1).maxLength(64),
    firstName: vine.string().trim().minLength(1).maxLength(80),
    middleName: vine.string().trim().maxLength(80).optional(),
    lastName: vine.string().trim().minLength(1).maxLength(80),
    dateOfBirth: vine.string().trim().optional(),
    gender: vine.enum(['male', 'female', 'other'] as const).optional(),
    admissionYear: vine.number().min(1900).max(2100).optional(),
    classId: vine.number().positive().nullable().optional(),
    medicalNotes: vine.string().trim().maxLength(2000).optional(),
    photoUrl: vine.string().trim().url().optional(),
    ...extras,
    parents: vine
      .array(
        vine.object({
          parentUserId: vine.number().positive(),
          relationship: vine.string().trim().maxLength(32).optional(),
          isPrimary: vine.boolean().optional(),
        })
      )
      .optional(),
  })
)

export const updateStudentValidator = vine.compile(
  vine.object({
    admissionNumber: vine.string().trim().minLength(1).maxLength(64).optional(),
    firstName: vine.string().trim().minLength(1).maxLength(80).optional(),
    middleName: vine.string().trim().maxLength(80).nullable().optional(),
    lastName: vine.string().trim().minLength(1).maxLength(80).optional(),
    dateOfBirth: vine.string().trim().nullable().optional(),
    gender: vine.enum(['male', 'female', 'other'] as const).nullable().optional(),
    admissionYear: vine.number().min(1900).max(2100).nullable().optional(),
    classId: vine.number().positive().nullable().optional(),
    medicalNotes: vine.string().trim().maxLength(2000).nullable().optional(),
    photoUrl: vine.string().trim().url().nullable().optional(),
    isArchived: vine.boolean().optional(),
    ...extras,
  })
)
