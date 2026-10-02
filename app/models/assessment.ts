import { AssessmentSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'

export default class Assessment extends AssessmentSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
