import { SchoolSchema } from '#database/schema'
import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import UserSchoolRole from '#models/user_school_role'
import SchoolClass from '#models/school_class'
import Subject from '#models/subject'
import Student from '#models/student'

export default class School extends SchoolSchema {
  @hasMany(() => UserSchoolRole)
  declare roleAssignments: HasMany<typeof UserSchoolRole>

  @hasMany(() => SchoolClass)
  declare classes: HasMany<typeof SchoolClass>

  @hasMany(() => Subject)
  declare subjects: HasMany<typeof Subject>

  @hasMany(() => Student)
  declare students: HasMany<typeof Student>
}
