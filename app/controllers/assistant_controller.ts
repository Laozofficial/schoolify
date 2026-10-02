import type { HttpContext } from '@adonisjs/core/http'
import { randomInt } from 'node:crypto'
import { DateTime } from 'luxon'
import AssistantConversation from '#models/assistant_conversation'
import AssistantMessage from '#models/assistant_message'
import WhatsappLink from '#models/whatsapp_link'
import { AiError, isAiConfigured } from '#services/ai'
import { familyAccess } from '#services/family_access'
import { runFamilyAssistant } from '#services/assistant/family_assistant'
import { isWhatsappConfigured, maskPhone, whatsappDisplayNumber } from '#services/whatsapp'

/**
 * In-app family assistant (parents + students) and WhatsApp linking.
 * Access is by relationship (own record / linked wards), not RBAC.
 */
export default class AssistantController {
  private serializeMessage(m: AssistantMessage) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      tools: m.meta?.tools ?? [],
      createdAt: m.createdAt,
    }
  }

  /** GET /assistant - availability, latest web conversation, suggestions. */
  async show(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const access = await familyAccess(user, ctx.school.id)
    if (access.students.length === 0) {
      return ctx.serialize({ enabled: false, reason: 'no_students' })
    }

    const conversation = await AssistantConversation.query()
      .where('user_id', user.id)
      .where('school_id', ctx.school.id)
      .where('channel', 'web')
      .orderBy('id', 'desc')
      .first()
    const messages = conversation
      ? await AssistantMessage.query()
          .where('conversation_id', conversation.id)
          .orderBy('id', 'desc')
          .limit(50)
      : []
    messages.reverse()

    const link = await WhatsappLink.query()
      .where('user_id', user.id)
      .where('school_id', ctx.school.id)
      .first()

    const first = access.students[0].firstName
    const many = access.students.length > 1
    const suggestions = access.isParent
      ? [
          many ? 'How are my children doing this term?' : `How is ${first} doing this term?`,
          'Do I owe any school fees?',
          `What does ${many ? 'the timetable' : `${first}'s timetable`} look like tomorrow?`,
          'Any homework due this week?',
          'When is the next school holiday?',
          "What is today's pickup code?",
        ]
      : [
          'What homework is due this week?',
          'What is on my timetable tomorrow?',
          'How did I do in my last exams?',
          'Do I have any CBT exams open?',
          'When does this term end?',
        ]

    return ctx.serialize({
      enabled: isAiConfigured(),
      children: access.students.map((s) => ({ id: s.id, firstName: s.firstName })),
      conversationId: conversation?.id ?? null,
      messages: messages.map((m) => this.serializeMessage(m)),
      suggestions,
      whatsapp: {
        available: isWhatsappConfigured(),
        linked: link?.phone && link.linkedAt ? maskPhone(link.phone) : null,
      },
    })
  }

  /** POST /assistant/messages { message, conversationId? } */
  async send(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const message = String(ctx.request.input('message') ?? '').trim()
    if (!message) return ctx.response.badRequest({ message: 'Please type a question.' })
    if (message.length > 1000) {
      return ctx.response.badRequest({ message: 'Please keep questions under 1000 characters.' })
    }

    const conversationId = Number(ctx.request.input('conversationId')) || null
    let conversation = conversationId
      ? await AssistantConversation.query()
          .where('id', conversationId)
          .where('user_id', user.id)
          .where('school_id', ctx.school.id)
          .where('channel', 'web')
          .first()
      : null
    if (!conversation) {
      conversation = await AssistantConversation.create({
        schoolId: ctx.school.id,
        userId: user.id,
        channel: 'web',
        title: null,
      })
    }

    try {
      const { reply, userMessage } = await runFamilyAssistant({
        user,
        school: ctx.school,
        conversation,
        message,
        channel: 'web',
      })
      return ctx.serialize({
        conversationId: conversation.id,
        userMessage: this.serializeMessage(userMessage),
        reply: this.serializeMessage(reply),
      })
    } catch (e) {
      if (e instanceof AiError) {
        return ctx.response.status(e.status).send({ message: e.message, conversationId: conversation.id })
      }
      throw e
    }
  }

  /**
   * POST /assistant/whatsapp/link - issue a one-time code the parent sends
   * from WhatsApp ("LINK 123456") to prove they own the number.
   */
  async createLink(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    if (!isWhatsappConfigured()) {
      return ctx.response.serviceUnavailable({ message: 'WhatsApp is not enabled for this school yet.' })
    }
    const access = await familyAccess(user, ctx.school.id)
    if (access.students.length === 0) {
      return ctx.response.forbidden({ message: 'No student is linked to this account.' })
    }

    // Retry on the (rare) collision with another live code.
    let code = ''
    for (let i = 0; i < 5; i++) {
      code = String(randomInt(100000, 1000000))
      const clash = await WhatsappLink.query()
        .where('code', code)
        .where('code_expires_at', '>', DateTime.now().toSQL()!)
        .first()
      if (!clash) break
    }
    const expiresAt = DateTime.now().plus({ minutes: 15 })
    const link = await WhatsappLink.updateOrCreate(
      { userId: user.id, schoolId: ctx.school.id },
      { code, codeExpiresAt: expiresAt }
    )
    const number = whatsappDisplayNumber()
    return ctx.serialize({
      code: link.code,
      expiresAt,
      displayNumber: number ? '+' + number : null,
      waLink: number ? `https://wa.me/${number}?text=${encodeURIComponent(`LINK ${code}`)}` : null,
    })
  }

  /** DELETE /assistant/whatsapp - disconnect WhatsApp. */
  async unlink(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    await WhatsappLink.query().where('user_id', user.id).where('school_id', ctx.school.id).delete()
    return ctx.serialize({ ok: true })
  }
}
