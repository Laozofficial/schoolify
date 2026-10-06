import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import logger from '@adonisjs/core/services/logger'
import { Worker as BullWorker, Queue as BullQueue, type Job } from 'bullmq'
import { jobsByQueue } from '#jobs/index'
import { redisConnection, knownQueueNames } from '#services/queue'
import PeriodReminderJob from '#jobs/period_reminder_job'
import RiskScanJob from '#jobs/risk_scan_job'
import InstallmentReminderJob from '#jobs/installment_reminder_job'
import BillingSweepJob from '#jobs/billing_sweep_job'

export default class Worker extends BaseCommand {
  static commandName = 'worker'
  static description = 'Run BullMQ workers for all registered queues'
  static options: CommandOptions = { startApp: true, staysAlive: true }

  async run() {
    const connection = { ...redisConnection(), maxRetriesPerRequest: null }
    const grouped = jobsByQueue()
    const workers: BullWorker[] = []

    for (const queueName of knownQueueNames()) {
      const jobsOnQueue = grouped[queueName] ?? []
      const handlers = new Map(jobsOnQueue.map((J) => [J.jobName, J]))

      const worker = new BullWorker(
        queueName,
        async (job: Job) => {
          const HandlerCtor = handlers.get(job.name)
          if (!HandlerCtor) {
            throw new Error(`No handler registered for job "${job.name}" on queue "${queueName}"`)
          }
          const instance = new HandlerCtor()
          await instance.handle(job.data)
        },
        { connection }
      )

      worker.on('failed', (job, err) => {
        logger.error({ err, jobId: job?.id, name: job?.name }, 'job failed')
      })
      worker.on('completed', (job) => {
        logger.info({ jobId: job.id, name: job.name }, 'job completed')
      })

      logger.info({ queue: queueName, jobs: jobsOnQueue.map((J) => J.jobName) }, 'worker started')
      workers.push(worker)
    }

    // Register the every-minute period-reminder heartbeat. Idempotent -
    // repeatable jobs are keyed by `jobId` so restarts don't duplicate.
    const reminderQueue = new BullQueue(PeriodReminderJob.queueName, { connection })
    await reminderQueue.add(
      PeriodReminderJob.jobName,
      {},
      {
        repeat: { pattern: '* * * * *' }, // every minute
        jobId: PeriodReminderJob.repeatKey,
      }
    )
    logger.info('period-reminder heartbeat scheduled (every minute)')

    // Weekly early warning scan + digests: Mondays 07:00 Lagos time.
    await reminderQueue.add(
      RiskScanJob.jobName,
      {},
      {
        repeat: { pattern: '0 7 * * 1', tz: 'Africa/Lagos' },
        jobId: RiskScanJob.repeatKey,
      }
    )
    logger.info('risk-scan scheduled (Mondays 07:00 Africa/Lagos)')

    // Fee instalment reminders: every day 08:00 Lagos time.
    await reminderQueue.add(
      InstallmentReminderJob.jobName,
      {},
      {
        repeat: { pattern: '0 8 * * *', tz: 'Africa/Lagos' },
        jobId: InstallmentReminderJob.repeatKey,
      }
    )
    logger.info('instalment reminders scheduled (daily 08:00 Africa/Lagos)')

    // Plan renewals and AI credit top-ups: every five minutes.
    await reminderQueue.add(
      BillingSweepJob.jobName,
      {},
      {
        repeat: { pattern: '*/5 * * * *' },
        jobId: BillingSweepJob.repeatKey,
      }
    )
    logger.info('billing sweep scheduled (every 5 minutes)')

    const shutdown = async () => {
      logger.info('worker shutdown signal received')
      await Promise.all(workers.map((w) => w.close()))
      await this.app.terminate()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
}
