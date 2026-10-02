import vine from '@vinejs/vine'
import { PAYMENT_METHODS } from '#models/payment'

const feeItemValidator = vine.object({
  description: vine.string().trim().minLength(1).maxLength(200),
  /** Naira on the wire; controller converts to kobo. */
  amount: vine.number().min(0),
  isOptional: vine.boolean().optional(),
})

export const createFeeStructureValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(200),
    /** Legacy single class - still accepted; new callers should send classIds. */
    classId: vine.number().positive().nullable().optional(),
    /** Multi-class targeting. null/empty = applies to any class. */
    classIds: vine.array(vine.number().positive()).optional(),
    termId: vine.number().positive().nullable().optional(),
    items: vine.array(feeItemValidator).minLength(1),
  })
)

export const updateFeeStructureValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(200).optional(),
    classId: vine.number().positive().nullable().optional(),
    classIds: vine.array(vine.number().positive()).nullable().optional(),
    termId: vine.number().positive().nullable().optional(),
    items: vine.array(feeItemValidator).optional(),
  })
)

export const generateInvoicesValidator = vine.compile(
  vine.object({
    feeStructureId: vine.number().positive(),
    termId: vine.number().positive(),
    classIds: vine.array(vine.number().positive()).minLength(1),
    dueOn: vine.string().trim().optional(),
  })
)

export const createManualInvoiceValidator = vine.compile(
  vine.object({
    studentId: vine.number().positive(),
    termId: vine.number().positive(),
    dueOn: vine.string().trim().optional(),
    notes: vine.string().trim().maxLength(1000).optional(),
    items: vine
      .array(
        vine.object({
          description: vine.string().trim().minLength(1).maxLength(200),
          amount: vine.number().min(0),
        })
      )
      .minLength(1),
  })
)

export const recordPaymentValidator = vine.compile(
  vine.object({
    invoiceId: vine.number().positive(),
    amount: vine.number().min(0),
    method: vine.enum(PAYMENT_METHODS),
    reference: vine.string().trim().maxLength(120).optional(),
    paidAt: vine.string().trim().optional(),
    notes: vine.string().trim().maxLength(1000).optional(),
  })
)

/**
 * Bulk payment - one amount applied against each selected student's oldest
 * outstanding invoice. Students with no outstanding invoice are skipped and
 * reported back so the caller can surface them.
 */
export const bulkPaymentValidator = vine.compile(
  vine.object({
    studentIds: vine.array(vine.number().positive()).minLength(1),
    amount: vine.number().min(0),
    method: vine.enum(PAYMENT_METHODS),
    reference: vine.string().trim().maxLength(120).optional(),
    paidAt: vine.string().trim().optional(),
    notes: vine.string().trim().maxLength(1000).optional(),
  })
)
