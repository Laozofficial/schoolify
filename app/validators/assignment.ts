import vine from '@vinejs/vine'

export const createAssignmentValidator = vine.compile(
  vine.object({
    classId: vine.number().positive(),
    subjectId: vine.number().positive(),
    title: vine.string().trim().minLength(1).maxLength(200),
    description: vine.string().trim().maxLength(10_000).optional(),
    rubric: vine.string().trim().maxLength(10_000).optional(),
    deadline: vine.string().trim().optional(),
    maxScore: vine.number().min(1).max(1000).optional(),
    attachmentUrl: vine.string().trim().url().optional(),
    published: vine.boolean().optional(),
  })
)

export const updateAssignmentValidator = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200).optional(),
    description: vine.string().trim().maxLength(10_000).nullable().optional(),
    rubric: vine.string().trim().maxLength(10_000).nullable().optional(),
    deadline: vine.string().trim().nullable().optional(),
    maxScore: vine.number().min(1).max(1000).optional(),
    attachmentUrl: vine.string().trim().url().nullable().optional(),
    published: vine.boolean().optional(),
  })
)

export const submitAssignmentValidator = vine.compile(
  vine.object({
    content: vine.string().trim().maxLength(20_000).optional(),
    attachmentUrl: vine.string().trim().url().optional(),
  })
)

export const gradeSubmissionValidator = vine.compile(
  vine.object({
    score: vine.number().min(0),
    feedback: vine.string().trim().maxLength(5000).nullable().optional(),
  })
)
