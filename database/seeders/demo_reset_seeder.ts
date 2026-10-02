import { BaseSeeder } from '@adonisjs/lucid/seeders'
import logger from '@adonisjs/core/services/logger'
import User from '#models/user'

/**
 * Resets four demo login accounts (one per role) to known passwords
 * with must-change-password OFF, so a developer can log in and browse
 * without hitting the change-password modal.
 *
 * Run:  node ace db:seed --files ./database/seeders/demo_reset_seeder.ts
 */
export default class DemoResetSeeder extends BaseSeeder {
  async run() {
    const targets = [
      { email: 'superadmin@demo-academy.test', password: 'admin1234' },
      { email: 'adeola.ogundipe@demo-academy.test', password: 'teacher1234' },
      { email: 'lovelace.parent@demo-academy.test', password: 'parent1234' },
      { email: 'adm20260001@students.demo-academy.local', password: 'student1234' },
    ]
    for (const t of targets) {
      const u = await User.findBy('email', t.email)
      if (!u) {
        logger.warn(`demo:reset missing ${t.email}`)
        continue
      }
      u.password = t.password
      u.mustChangePassword = false
      await u.save()
      logger.info(`demo:reset ${t.email}`)
    }
  }
}
