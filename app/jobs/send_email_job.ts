import { BaseJob, type JobPayload } from '#jobs/base_job'

export interface SendEmailPayload extends JobPayload {
  to: string
  subject: string
  body: string
}

export default class SendEmailJob extends BaseJob<SendEmailPayload> {
  static queueName = 'default'
  static jobName = 'send_email'

  async handle(payload: SendEmailPayload) {
    this.logger.info({ payload }, 'send_email job handled (stub)')
  }
}
