import vine from '@vinejs/vine'

export const setGradeScaleValidator = vine.compile(
  vine.object({
    scale: vine
      .array(
        vine.object({
          grade: vine.string().trim().minLength(1).maxLength(4),
          minPercentage: vine.number().min(0).max(100),
          remark: vine.string().trim().minLength(1).maxLength(60),
          orderIndex: vine.number().min(0).optional(),
        })
      )
      .minLength(1),
  })
)

export const approveReportsValidator = vine.compile(
  vine.object({
    termId: vine.number().positive(),
    studentIds: vine.array(vine.number().positive()).minLength(1),
  })
)
