import { BaseJob, type JobPayload } from '#jobs/base_job'
import School from '#models/school'
import Integration from '#models/integration'
import MessageCampaign from '#models/message_campaign'
import MessageDelivery from '#models/message_delivery'
import { sendDelivery } from '#services/messaging'

export interface SendCampaignPayload extends JobPayload {
  campaignId: number
}

/** How many provider calls run at once for one campaign. */
const CONCURRENCY = 4

/**
 * Sends every queued delivery of a campaign. Safe to re-run: it only picks
 * rows still in `queued`, so a retry after a crash never double-sends.
 */
export default class SendCampaignJob extends BaseJob<SendCampaignPayload> {
  static queueName = 'default'
  static jobName = 'send_campaign'

  async handle({ campaignId }: SendCampaignPayload) {
    const campaign = await MessageCampaign.find(campaignId)
    if (!campaign) return
    const school = await School.findOrFail(campaign.schoolId)
    campaign.status = 'sending'
    await campaign.save()

    const queued = await MessageDelivery.query()
      .where('campaign_id', campaignId)
      .where('status', 'queued')
      .orderBy('id', 'asc')
    const integrationIds = [...new Set(queued.map((d) => d.integrationId).filter((v): v is number => !!v))]
    const integrations = new Map<number, Integration>()
    if (integrationIds.length) {
      for (const i of await Integration.query().whereIn('id', integrationIds)) integrations.set(i.id, i)
    }

    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, queued.length) }, async () => {
      while (cursor < queued.length) {
        const row = queued[cursor++]
        await sendDelivery(row, school, integrations)
      }
    })
    await Promise.all(workers)

    campaign.status = 'done'
    await campaign.save()
  }
}
