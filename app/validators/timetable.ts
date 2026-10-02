import vine from '@vinejs/vine'

const timeString = () =>
  vine
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const createPeriodValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60),
    startTime: timeString(),
    endTime: timeString(),
    orderIndex: vine.number().min(0).optional(),
    isBreak: vine.boolean().optional(),
  })
)

export const updatePeriodValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60).optional(),
    startTime: timeString().optional(),
    endTime: timeString().optional(),
    orderIndex: vine.number().min(0).optional(),
    isBreak: vine.boolean().optional(),
  })
)

export const setTimetableSlotsValidator = vine.compile(
  vine.object({
    slots: vine.array(
      vine.object({
        dayOfWeek: vine.number().min(1).max(7),
        periodId: vine.number().positive(),
        subjectId: vine.number().positive().nullable().optional(),
        teacherId: vine.number().positive().nullable().optional(),
        notes: vine.string().trim().maxLength(200).nullable().optional(),
      })
    ),
  })
)

export const createSlotValidator = vine.compile(
  vine.object({
    classId: vine.number().positive(),
    dayOfWeek: vine.number().min(1).max(7),
    /**
     * One or more periods. Passing multiple creates a "double lesson" - one
     * slot per period, all with the same subject/teacher/notes.
     */
    periodIds: vine.array(vine.number().positive()).minLength(1),
    subjectId: vine.number().positive().nullable().optional(),
    teacherId: vine.number().positive().nullable().optional(),
    notes: vine.string().trim().maxLength(200).nullable().optional(),
  })
)

/**
 * Upsert-or-clear a one-off exception for a specific slot on a specific
 * date. Any field can be sent; nulls mean "inherit from base slot" (not
 * "clear to nothing"). Send `isCancelled: true` to skip the slot for
 * that date entirely.
 */
export const upsertSlotExceptionValidator = vine.compile(
  vine.object({
    date: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    subjectId: vine.number().positive().nullable().optional(),
    teacherId: vine.number().positive().nullable().optional(),
    notes: vine.string().trim().maxLength(200).nullable().optional(),
    isCancelled: vine.boolean().optional(),
  })
)

export const autoGenerateValidator = vine.compile(
  vine.object({
    /**
     * fill = keep existing slots and only fill gaps.
     * replace = wipe the whole school timetable first, then rebuild.
     */
    mode: vine.enum(['fill', 'replace'] as const),
    /** How many periods per week each subject should appear in a class. */
    slotsPerSubject: vine.number().min(1).max(20),
    /** Days of week to schedule on (1=Mon…7=Sun). Defaults to Mon-Fri. */
    daysOfWeek: vine.array(vine.number().min(1).max(7)).minLength(1).optional(),
  })
)

export const updateSlotValidator = vine.compile(
  vine.object({
    dayOfWeek: vine.number().min(1).max(7).optional(),
    periodId: vine.number().positive().optional(),
    subjectId: vine.number().positive().nullable().optional(),
    teacherId: vine.number().positive().nullable().optional(),
    notes: vine.string().trim().maxLength(200).nullable().optional(),
  })
)
