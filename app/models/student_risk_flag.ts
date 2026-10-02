import { StudentRiskFlagSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export interface RiskSignal {
  kind: string
  label: string
  detail: string
  weight: number
  /** Only admins see this signal (e.g. fees). */
  adminOnly?: boolean
}

export default class StudentRiskFlag extends StudentRiskFlagSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare signals: RiskSignal[]

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>
}
