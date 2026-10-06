import vine from '@vinejs/vine'

const values = vine.record(vine.string().trim().maxLength(4000))

export const createIntegrationValidator = vine.compile(
  vine.object({
    provider: vine.string().trim().maxLength(40),
    label: vine.string().trim().maxLength(120).nullable().optional(),
    values,
    isDefault: vine.boolean().optional(),
  })
)

export const updateIntegrationValidator = vine.compile(
  vine.object({
    label: vine.string().trim().maxLength(120).nullable().optional(),
    /** Secret fields left blank keep their stored value. */
    values: values.optional(),
    isDefault: vine.boolean().optional(),
    status: vine.enum(['connected', 'disabled']).optional(),
  })
)

export const testIntegrationValidator = vine.compile(
  vine.object({
    /** Optional phone/email to receive a real test message. */
    to: vine.string().trim().maxLength(200).optional(),
  })
)

const channel = vine.enum(['sms', 'email', 'whatsapp', 'in_app'])

const audience = vine.object({
  type: vine.enum([
    'all_parents',
    'parents_of_classes',
    'parents_of_students',
    'all_staff',
    'staff_roles',
    'students_of_classes',
    'users',
  ]),
  classIds: vine.array(vine.number()).optional(),
  studentIds: vine.array(vine.number()).optional(),
  roles: vine.array(vine.string()).optional(),
  userIds: vine.array(vine.number()).optional(),
})

export const audiencePreviewValidator = vine.compile(vine.object({ audience }))

export const sendCampaignValidator = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200),
    channels: vine.array(channel).minLength(1),
    audience,
    subject: vine.string().trim().maxLength(200).nullable().optional(),
    body: vine.string().trim().minLength(1).maxLength(5000),
  })
)

export const templateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    channel: vine.enum(['any', 'sms', 'email', 'whatsapp']).optional(),
    subject: vine.string().trim().maxLength(200).nullable().optional(),
    body: vine.string().trim().minLength(1).maxLength(5000),
  })
)

export const automationsValidator = vine.compile(
  vine.object({
    automations: vine.record(
      vine.object({
        enabled: vine.boolean(),
        channels: vine.array(channel),
        subject: vine.string().trim().maxLength(200).nullable().optional(),
        body: vine.string().trim().maxLength(2000).nullable().optional(),
      })
    ),
  })
)
