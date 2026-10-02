import { TermSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'

export const TERM_NAMES = ['first', 'second', 'third'] as const
export type TermName = (typeof TERM_NAMES)[number]

export default class Term extends TermSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
