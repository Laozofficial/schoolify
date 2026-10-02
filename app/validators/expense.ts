import vine from '@vinejs/vine'
import { EXPENSE_CATEGORIES } from '#models/expense'

const base = {
  category: vine.enum(EXPENSE_CATEGORIES),
  description: vine.string().trim().minLength(1).maxLength(255),
  /** Naira as decimal on the wire; controller converts to kobo (int) before storing. */
  amount: vine.number().min(0),
  incurredOn: vine.string().trim(),
  receiptUrl: vine.string().trim().url().nullable().optional(),
  notes: vine.string().trim().maxLength(1000).nullable().optional(),
}

export const createExpenseValidator = vine.compile(vine.object(base))

export const updateExpenseValidator = vine.compile(
  vine.object({
    category: base.category.optional(),
    description: base.description.optional(),
    amount: base.amount.optional(),
    incurredOn: base.incurredOn.optional(),
    receiptUrl: base.receiptUrl,
    notes: base.notes,
  })
)
