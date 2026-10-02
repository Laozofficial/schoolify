import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { type AccessToken, DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import { hasMany, hasOne, manyToMany } from '@adonisjs/lucid/orm'
import type { HasMany, HasOne, ManyToMany } from '@adonisjs/lucid/types/relations'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import Student from '#models/student'

// Factory, not the service itself: ace commands (e.g. the worker) can load
// this model before the app boots, when the `hash` binding is still unset.
export default class User extends compose(UserSchema, withAuthFinder(() => hash.use())) {
  static accessTokens = DbAccessTokensProvider.forModel(User)
  declare currentAccessToken?: AccessToken

  @hasMany(() => UserSchoolRole)
  declare roleAssignments: HasMany<typeof UserSchoolRole>

  /** When this user is a student, the linked Student row. */
  @hasOne(() => Student)
  declare studentProfile: HasOne<typeof Student>

  /** When this user is a parent, all wards linked via parent_students. */
  @manyToMany(() => Student, {
    pivotTable: 'parent_students',
    localKey: 'id',
    pivotForeignKey: 'parent_user_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'student_id',
    pivotColumns: ['relationship', 'is_primary'],
  })
  declare wards: ManyToMany<typeof Student>

  get initials() {
    const source = this.fullName || this.surname || this.email
    const parts = source.includes(' ') ? source.split(' ') : source.split('@')
    const [first, last] = parts
    if (first && last) {
      return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
    }
    return first.slice(0, 2).toUpperCase()
  }

  async rolesAtSchool(schoolId: number): Promise<Role[]> {
    const rows = await UserSchoolRole.query()
      .where('user_id', this.id)
      .where('school_id', schoolId)
    return rows.map((r) => r.role)
  }

  async hasRole(schoolId: number, role: Role): Promise<boolean> {
    const row = await UserSchoolRole.query()
      .where('user_id', this.id)
      .where('school_id', schoolId)
      .where('role', role)
      .first()
    return row !== null
  }
}
