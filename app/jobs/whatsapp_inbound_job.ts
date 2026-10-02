import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import { BaseJob } from '#jobs/base_job'
import WhatsappLink from '#models/whatsapp_link'
import AssistantConversation from '#models/assistant_conversation'
import AssistantMessage from '#models/assistant_message'
import User from '#models/user'
import School from '#models/school'
import { AiError } from '#services/ai'
import { runFamilyAssistant } from '#services/assistant/family_assistant'
import { familyAccess } from '#services/family_access'
import { normalizePhone, sendWhatsappText } from '#services/whatsapp'

interface Payload {
  [key: string]: unknown
  from: string
  text: string | null
  messageId: string
}

const LINK_RE = /^\s*link\s+(\d{6})\s*$/i
const RESET_RE = /^\s*(reset|new chat|restart)\s*$/i

/**
 * Handles one inbound WhatsApp message off the webhook's hot path (Meta
 * expects a fast 200). Flows:
 *  - "LINK 123456": proves the number belongs to the portal user who
 *    generated the code, and links it.
 *  - linked number: runs the family assistant and replies.
 *  - unknown number: explains how to link.
 */
export default class WhatsappInboundJob extends BaseJob<Payload> {
  static queueName = 'default'
  static jobName = 'whatsapp_inbound'

  async handle(payload: Payload) {
    const phone = normalizePhone(payload.from)
    if (!phone) return

    // Webhook retries: the message id is stored on the first pass.
    const seen = await AssistantMessage.findBy('external_id', payload.messageId)
    if (seen) return

    if (!payload.text) {
      await sendWhatsappText(phone, 'Sorry, I can only read text messages for now. Please type your question.')
      return
    }

    const linkMatch = payload.text.match(LINK_RE)
    if (linkMatch) return this.link(phone, linkMatch[1])

    const link = await WhatsappLink.query().where('phone', phone).whereNotNull('linked_at').first()
    if (!link) {
      await sendWhatsappText(
        phone,
        'Hello! To chat with your school assistant here, open the school portal, tap the assistant button, choose "Chat on WhatsApp" and send the code it shows you.'
      )
      return
    }

    const [user, school] = await Promise.all([User.find(link.userId), School.find(link.schoolId)])
    if (!user || !school) return

    if (RESET_RE.test(payload.text)) {
      await AssistantConversation.create({ schoolId: school.id, userId: user.id, channel: 'whatsapp', title: null })
      await sendWhatsappText(phone, 'Started a fresh conversation. What would you like to know?')
      return
    }

    let conversation = await AssistantConversation.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
      .where('channel', 'whatsapp')
      .orderBy('id', 'desc')
      .first()
    // Start fresh after 12 hours of silence so old context does not leak in.
    if (!conversation || (conversation.updatedAt && conversation.updatedAt < DateTime.now().minus({ hours: 12 }))) {
      conversation = await AssistantConversation.create({
        schoolId: school.id,
        userId: user.id,
        channel: 'whatsapp',
        title: null,
      })
    }

    try {
      const { reply } = await runFamilyAssistant({
        user,
        school,
        conversation,
        message: payload.text,
        channel: 'whatsapp',
        externalId: payload.messageId,
      })
      await sendWhatsappText(phone, reply.content)
    } catch (e) {
      if (e instanceof AiError) {
        await sendWhatsappText(phone, e.message)
        return
      }
      // A unique violation on external_id means a concurrent retry won.
      if ((e as { code?: string })?.code === '23505') return
      logger.error({ err: e }, 'whatsapp assistant failed')
      await sendWhatsappText(phone, 'Sorry, something went wrong. Please try again in a moment.')
    }
  }

  private async link(phone: string, code: string) {
    const pending = await WhatsappLink.query()
      .where('code', code)
      .where('code_expires_at', '>', DateTime.now().toSQL()!)
      .first()
    if (!pending) {
      await sendWhatsappText(
        phone,
        'That code is not valid or has expired. Open the portal and choose "Chat on WhatsApp" to get a new one.'
      )
      return
    }
    // A number belongs to one account at a time; move it if needed.
    await WhatsappLink.query().where('phone', phone).whereNot('id', pending.id).update({ phone: null, linked_at: null })
    pending.phone = phone
    pending.linkedAt = DateTime.now()
    pending.code = null
    pending.codeExpiresAt = null
    await pending.save()

    const [user, school] = await Promise.all([User.find(pending.userId), School.find(pending.schoolId)])
    const access = user && school ? await familyAccess(user, school.id) : null
    const names = access?.students.map((s) => s.firstName).join(', ')
    await sendWhatsappText(
      phone,
      `You're connected to ${school?.name ?? 'your school'}'s assistant.${names ? ` Ask me anything about ${names}:` : ''} results, attendance, fees, homework, timetable or school dates. Send RESET anytime to start over.`
    )
  }
}
