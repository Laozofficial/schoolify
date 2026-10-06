import type { BaseJob } from '#jobs/base_job'
import SendEmailJob from '#jobs/send_email_job'
import SendInviteJob from '#jobs/send_invite_job'
import SendPromotionEmailJob from '#jobs/send_promotion_email_job'
import PeriodReminderJob from '#jobs/period_reminder_job'
import WhatsappInboundJob from '#jobs/whatsapp_inbound_job'
import RiskScanJob from '#jobs/risk_scan_job'
import SendCampaignJob from '#jobs/send_campaign_job'
import InstallmentReminderJob from '#jobs/installment_reminder_job'

type JobCtor = (new () => BaseJob<any>) & { queueName: string; jobName: string }

export const jobs: JobCtor[] = [
  SendEmailJob,
  SendInviteJob,
  SendPromotionEmailJob,
  PeriodReminderJob,
  WhatsappInboundJob,
  RiskScanJob,
  SendCampaignJob,
  InstallmentReminderJob,
]

export function jobsByQueue(): Record<string, JobCtor[]> {
  return jobs.reduce<Record<string, JobCtor[]>>((acc, Job) => {
    ;(acc[Job.queueName] ||= []).push(Job)
    return acc
  }, {})
}
