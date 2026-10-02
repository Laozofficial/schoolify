import vine from '@vinejs/vine'

/* ---------- bank accounts ---------- */
export const createBankAccountValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    bankName: vine.string().trim().minLength(1).maxLength(120),
    accountNumber: vine.string().trim().minLength(1).maxLength(40),
    accountType: vine.string().trim().maxLength(40).nullable().optional(),
    openingBalanceKobo: vine.number().min(0).optional(),
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
    isActive: vine.boolean().optional(),
  })
)
export const updateBankAccountValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    bankName: vine.string().trim().minLength(1).maxLength(120).optional(),
    accountNumber: vine.string().trim().minLength(1).maxLength(40).optional(),
    accountType: vine.string().trim().maxLength(40).nullable().optional(),
    openingBalanceKobo: vine.number().min(0).optional(),
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
    isActive: vine.boolean().optional(),
  })
)

/* ---------- visitors ---------- */
export const createVisitorValidator = vine.compile(
  vine.object({
    fullName: vine.string().trim().minLength(1).maxLength(160),
    phone: vine.string().trim().maxLength(40).nullable().optional(),
    idType: vine.string().trim().maxLength(40).nullable().optional(),
    idNumber: vine.string().trim().maxLength(60).nullable().optional(),
    purpose: vine.string().trim().maxLength(200).nullable().optional(),
    hostUserId: vine.number().positive().nullable().optional(),
    checkedInAt: vine.string().optional(), // ISO; defaults to now
    notes: vine.string().trim().maxLength(1000).nullable().optional(),
  })
)
export const checkoutVisitorValidator = vine.compile(
  vine.object({
    checkedOutAt: vine.string().optional(), // defaults to now
  })
)

/* ---------- leave requests ---------- */
export const createLeaveRequestValidator = vine.compile(
  vine.object({
    userId: vine.number().positive().optional(), // omit -> self
    kind: vine.string().trim().minLength(1).maxLength(40),
    startsOn: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endsOn: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: vine.string().trim().maxLength(1000).nullable().optional(),
    attachmentUrl: vine.string().trim().url().maxLength(500).nullable().optional(),
  })
)
export const decideLeaveRequestValidator = vine.compile(
  vine.object({
    status: vine.enum(['approved', 'denied'] as const),
    decisionNote: vine.string().trim().maxLength(500).nullable().optional(),
  })
)
