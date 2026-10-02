import vine from '@vinejs/vine'

export const createClassValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    level: vine.string().trim().maxLength(60).optional(),
    classTeacherId: vine.number().positive().optional(),
  })
)

export const updateClassValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    level: vine.string().trim().maxLength(60).nullable().optional(),
    classTeacherId: vine.number().positive().nullable().optional(),
  })
)
