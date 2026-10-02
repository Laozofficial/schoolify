import vine from '@vinejs/vine'

export const createParentValidator = vine.compile(
  vine.object({
    email: vine.string().trim().email(),
    fullName: vine.string().trim().minLength(1).maxLength(160),
    surname: vine.string().trim().minLength(1).maxLength(80),
    phone: vine.string().trim().maxLength(32).optional(),
    studentIds: vine.array(vine.number().positive()).optional(),
  })
)

export const updateParentValidator = vine.compile(
  vine.object({
    fullName: vine.string().trim().minLength(1).maxLength(160).optional(),
    surname: vine.string().trim().minLength(1).maxLength(80).optional(),
    phone: vine.string().trim().maxLength(32).nullable().optional(),
  })
)

export const parentLinkValidator = vine.compile(
  vine.object({
    studentId: vine.number().positive(),
    relationship: vine.string().trim().maxLength(32).optional(),
    isPrimary: vine.boolean().optional(),
  })
)
