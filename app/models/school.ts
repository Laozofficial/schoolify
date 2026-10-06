import { SchoolSchema } from '#database/schema'
import { column, hasMany } from '@adonisjs/lucid/orm'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import UserSchoolRole from '#models/user_school_role'
import SchoolClass from '#models/school_class'
import Subject from '#models/subject'
import Student from '#models/student'

export default class School extends SchoolSchema {
  /** Per-school switches: automations, modules, gate settings. See #services/school_settings. */
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare settings: Record<string, unknown> | null

  @hasMany(() => UserSchoolRole)
  declare roleAssignments: HasMany<typeof UserSchoolRole>

  @hasMany(() => SchoolClass)
  declare classes: HasMany<typeof SchoolClass>

  @hasMany(() => Subject)
  declare subjects: HasMany<typeof Subject>

  @hasMany(() => Student)
  declare students: HasMany<typeof Student>
}
