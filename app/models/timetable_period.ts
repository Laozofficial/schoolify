import { TimetablePeriodSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'

export default class TimetablePeriod extends TimetablePeriodSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
