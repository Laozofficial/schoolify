import { ExpenseSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'
import User from '#models/user'

export const EXPENSE_CATEGORIES = [
  'fuel',
  'stationery',
  'maintenance',
  'purchases',
  'exam',
  'utilities',
  'transport',
  'food',
  'other',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export default class Expense extends ExpenseSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>

  @belongsTo(() => User, { foreignKey: 'recordedByUserId' })
  declare recordedBy: BelongsTo<typeof User>
}
