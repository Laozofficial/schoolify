import User from '#models/user'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import db from '@adonisjs/lucid/services/db'

export interface ProvisionOptions {
  email: string
  fullName?: string | null
  surname?: string | null
  phone?: string | null
  password?: string
  mustChangePassword?: boolean
  schoolId: number
  roles: Role[]
}

export interface ProvisionResult {
  user: User
  tempPassword: string | null
}

/**
 * Sensible default password for onboarded users: their surname lowercased,
 * with digits appended if surname is missing. `mustChangePassword` gates the
 * user out of the app until they set their own.
 */
export function deriveDefaultPassword(surname?: string | null): string {
  const base = (surname ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (base.length >= 6) return base
  return (base || 'welcome') + Math.floor(1000 + Math.random() * 9000).toString()
}

/**
 * Creates a user (if missing) and attaches the given roles at the school.
 * Idempotent per email - re-invoking with the same email just adds any missing
 * role assignments.
 */
export async function provisionUserWithRoles(opts: ProvisionOptions): Promise<ProvisionResult> {
  return db.transaction(async (trx) => {
    const existing = await User.query({ client: trx }).where('email', opts.email).first()

    let user: User
    let tempPassword: string | null = null

    if (existing) {
      user = existing
    } else {
      const password = opts.password ?? deriveDefaultPassword(opts.surname)
      tempPassword = password
      user = await User.create(
        {
          email: opts.email,
          fullName: opts.fullName ?? null,
          surname: opts.surname ?? null,
          phone: opts.phone ?? null,
          password,
          mustChangePassword: opts.mustChangePassword ?? true,
        },
        { client: trx }
      )
    }

    for (const role of opts.roles) {
      await UserSchoolRole.updateOrCreate(
        { userId: user.id, schoolId: opts.schoolId, role },
        {},
        { client: trx }
      )
    }

    return { user, tempPassword }
  })
}
