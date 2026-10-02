import { GradeScaleSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import School from '#models/school'

export const DEFAULT_WAEC_SCALE = [
  { grade: 'A', minPercentage: 70, remark: 'Excellent', orderIndex: 1 },
  { grade: 'B', minPercentage: 60, remark: 'Very good', orderIndex: 2 },
  { grade: 'C', minPercentage: 50, remark: 'Good', orderIndex: 3 },
  { grade: 'D', minPercentage: 45, remark: 'Fair', orderIndex: 4 },
  { grade: 'E', minPercentage: 40, remark: 'Pass', orderIndex: 5 },
  { grade: 'F', minPercentage: 0, remark: 'Fail', orderIndex: 6 },
] as const

export default class GradeScale extends GradeScaleSchema {
  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
