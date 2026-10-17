import env from '#start/env'

/**
 * Platform-wide pause for everything that runs on its own: the worker's
 * scheduled jobs and every automatic or bulk message (period alerts,
 * absence and fee automations, promotion emails, campaigns, instalment
 * reminders, risk digests, the billing sweep).
 *
 * Emails a person needs in order to get in (staff and parent invites with
 * their first password) are NOT covered and keep sending.
 *
 * Set AUTOMATIONS_PAUSED=true and restart the API and worker. The worker
 * also removes its schedules from Redis and drops any paused jobs still
 * waiting there, so nothing fires later from a queue that was filled before
 * the pause.
 */
export function automationsPaused(): boolean {
  return env.get('AUTOMATIONS_PAUSED') === true
}

export const PAUSED_MESSAGE = 'Automatic and bulk messages are paused on this platform right now.'

/** Job names that must not run while paused. */
export const PAUSED_JOB_NAMES = new Set([
  'period_reminder',
  'risk_scan',
  'installment_reminder',
  'billing_sweep',
  'send_campaign',
  'send_promotion_email',
])
