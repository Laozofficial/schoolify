import logger from '@adonisjs/core/services/logger'

export type JobPayload = Record<string, unknown>

export abstract class BaseJob<TPayload extends JobPayload = JobPayload> {
  /**
   * Queue name this job runs on. Group related jobs on one queue so a
   * single Worker can service them.
   */
  static queueName = 'default'

  /**
   * Unique job name - used by BullMQ to dispatch to the right handler.
   */
  static jobName: string

  abstract handle(payload: TPayload): Promise<void>

  protected get logger() {
    return logger
  }
}
