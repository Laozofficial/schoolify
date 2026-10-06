import logger from '@adonisjs/core/services/logger'
import { BaseJob } from '#jobs/base_job'
import { isTwelveAiConfigured } from '#services/twelveai'
import { sweepTopups } from '#services/ai_credits'
import { sweepSubscriptions } from '#services/billing'

/**
 * Every five minutes (see worker.ts): credits AI top-ups that were paid but
 * never confirmed by the return page, and refreshes plan subscriptions that
 * were due to renew, failed a charge or were left at checkout. This is the
 * only confirmation path when no webhook is registered, so it must stay.
 */
export default class BillingSweepJob extends BaseJob<Record<string, never>> {
  static queueName = 'default'
  static jobName = 'billing_sweep'
  static repeatKey = 'billing-sweep-5min'

  async handle() {
    if (!isTwelveAiConfigured()) return
    const credited = await sweepTopups()
    const synced = await sweepSubscriptions()
    if (credited || synced) logger.info({ credited, synced }, 'billing sweep')
  }
}
