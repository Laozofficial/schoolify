import vine from '@vinejs/vine'
import { TERM_NAMES } from '#models/term'

export const createTermValidator = vine.compile(
  vine.object({
    session: vine.string().trim().regex(/^\d{4}\/\d{4}$/),
    name: vine.enum(TERM_NAMES),
    startsOn: vine.string().trim(),
    endsOn: vine.string().trim(),
    isCurrent: vine.boolean().optional(),
  })
)

export const updateTermValidator = vine.compile(
  vine.object({
    session: vine.string().trim().regex(/^\d{4}\/\d{4}$/).optional(),
    name: vine.enum(TERM_NAMES).optional(),
    startsOn: vine.string().trim().optional(),
    endsOn: vine.string().trim().optional(),
    isCurrent: vine.boolean().optional(),
  })
)

export const createAssessmentValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60),
    weight: vine.number().min(0).max(100),
    maxScore: vine.number().min(1).max(1000).optional(),
    orderIndex: vine.number().min(0).optional(),
  })
)

export const updateAssessmentValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60).optional(),
    weight: vine.number().min(0).max(100).optional(),
    maxScore: vine.number().min(1).max(1000).optional(),
    orderIndex: vine.number().min(0).optional(),
  })
)

export const enterScoresValidator = vine.compile(
  vine.object({
    termId: vine.number().positive(),
    subjectId: vine.number().positive(),
    assessmentId: vine.number().positive(),
    entries: vine.array(
      vine.object({
        studentId: vine.number().positive(),
        score: vine.number().min(0),
      })
    ),
  })
)

export const upsertReportCommentValidator = vine.compile(
  vine.object({
    termId: vine.number().positive(),
    studentId: vine.number().positive(),
    classTeacherComment: vine.string().trim().maxLength(2000).nullable().optional(),
    principalComment: vine.string().trim().maxLength(2000).nullable().optional(),
  })
)
