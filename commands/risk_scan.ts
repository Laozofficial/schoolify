import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Run the early warning scan now (same work as the Monday job), including
 * the in-app digests to admins and class teachers.
 *
 *   node ace risk:scan              # every school
 *   node ace risk:scan --school=1   # one school
 */
export default class RiskScan extends BaseCommand {
  static commandName = 'risk:scan'
  static description = 'Run the early warning scan and send digests now'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'Only scan this school id' })
  declare school?: number

  async run() {
    // Imported lazily: ace loads command files before the app boots.
    const { default: RiskScanJob } = await import('#jobs/risk_scan_job')
    await new RiskScanJob().handle({ schoolId: this.school })
    this.logger.success('Early warning scan finished')
  }
}
