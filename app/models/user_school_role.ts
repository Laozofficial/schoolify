import { UserSchoolRoleSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from '#models/user'
import School from '#models/school'

export const ROLES = [
  'super_admin',
  'admin',
  'teacher',
  'non_academic_staff',
  'student',
  'parent',
  'accountant',
] as const

export type Role = (typeof ROLES)[number]

export default class UserSchoolRole extends UserSchoolRoleSchema {
  @column()
  declare role: Role

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @belongsTo(() => School)
  declare school: BelongsTo<typeof School>
}
