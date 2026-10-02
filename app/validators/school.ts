import vine from '@vinejs/vine'

export const updateSchoolValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(200).optional(),
    subdomain: vine.string().trim().maxLength(64).nullable().optional(),
    badgeUrl: vine.string().trim().url().nullable().optional(),
    letterheadUrl: vine.string().trim().url().nullable().optional(),
    signatureUrl: vine.string().trim().url().nullable().optional(),
    theme: vine
      .object({
        primary: vine.string().trim().maxLength(16).optional(),
        accent: vine.string().trim().maxLength(16).optional(),
      })
      .nullable()
      .optional(),
  })
)
