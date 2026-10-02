import vine from '@vinejs/vine'

/**
 * Either move students to `toClassId` OR set `graduate: true` (which archives
 * them). Passing both is a validation error.
 */
export const promoteValidator = vine.compile(
  vine.object({
    fromClassId: vine.number().positive(),
    toClassId: vine.number().positive().optional(),
    graduate: vine.boolean().optional(),
    studentIds: vine.array(vine.number().positive()).minLength(1),
  })
)
