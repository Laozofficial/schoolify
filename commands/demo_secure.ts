import { randomBytes, randomInt } from 'node:crypto'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Make demo data safe on a public server. The demo seeders give every
 * account a guessable password (the surname). This replaces EVERY password
 * at the school with a long random one, revokes all access tokens, and
 * gives the super admin a fresh one-time password (printed once, must be
 * changed at first login).
 *
 *   node ace demo:secure --school=demo-academy --admin=superadmin@demo-academy.test
 */
export default class DemoSecure extends BaseCommand {
  static commandName = 'demo:secure'
  static description = 'Replace all demo passwords with random ones and issue a one-time super admin password'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'School slug', default: 'demo-academy' })
  declare school: string

  @flags.string({ description: 'Super admin email to issue a one-time password for' })
  declare admin?: string

  async run() {
    // App modules are imported lazily: ace loads command files before the
    // app boots, so top-level imports of services (hash, db) can be unbound.
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { default: School } = await import('#models/school')
    const { default: User } = await import('#models/user')

    const school = await School.findBy('slug', this.school)
    if (!school) {
      this.logger.error(`School "${this.school}" not found`)
      this.exitCode = 1
      return
    }

    const rows = await db.from('user_school_roles').where('school_id', school.id).distinct('user_id')
    const userIds = rows.map((r) => r.user_id as number)
    const users = userIds.length ? await User.query().whereIn('id', userIds) : []

    for (const u of users) {
      u.password = randomBytes(24).toString('base64url')
      u.mustChangePassword = true
      await u.save()
    }
    if (userIds.length) {
      await db.from('auth_access_tokens').whereIn('tokenable_id', userIds).delete()
    }
    this.logger.success(`Replaced ${users.length} passwords and revoked their sessions`)

    if (this.admin) {
      const admin = users.find((u) => u.email === this.admin)
      if (!admin) {
        this.logger.error(`${this.admin} is not a member of ${school.name}`)
        this.exitCode = 1
        return
      }
      // Readable but strong: 4 groups of 4 from an unambiguous alphabet.
      const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
      const pick = () => alphabet[randomInt(alphabet.length)]
      const pw = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join('')).join('-')
      admin.password = pw
      admin.mustChangePassword = true
      await admin.save()
      this.logger.info(`ONE-TIME ADMIN PASSWORD for ${admin.email}: ${pw}`)
    }
  }
}
