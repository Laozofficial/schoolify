import vine from '@vinejs/vine'

export const createSubjectValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    code: vine.string().trim().maxLength(32).optional(),
    classIds: vine.array(vine.number().positive()).optional(),
  })
)

export const updateSubjectValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    code: vine.string().trim().maxLength(32).nullable().optional(),
    classIds: vine.array(vine.number().positive()).optional(),
  })
)
