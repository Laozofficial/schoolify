import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import AssistantConversation from '#models/assistant_conversation'
import AssistantMessage from '#models/assistant_message'
import Announcement from '#models/announcement'
import { AiError, isAiConfigured } from '#services/ai'
import { runCopilot } from '#services/copilot/copilot'
import { feeReminderTargets } from '#services/copilot/copilot_tools'
import { naira } from '#services/assistant/family_tools'
import { notifyUsers, studentAudience } from '#services/notify'

const AUDIENCE_ROLES: Record<string, string[] | null> = {
  everyone: null,
  parents: ['parent'],
  students: ['student'],
  staff: ['super_admin', 'admin', 'teacher', 'accountant', 'non_academic_staff'],
  teachers: ['teacher'],
}

/**
 * Admin copilot (routes are admin-only). Action cards proposed by the model
 * are stored on the reply message; executing one uses the STORED parameters
 * (never values sent by the browser) and can only happen once.
 */
export default class CopilotController {
  private serialize(m: AssistantMessage) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      tools: m.meta?.tools ?? [],
      actions: m.meta?.actions ?? [],
      createdAt: m.createdAt,
    }
  }

  /** GET /copilot */
  async show(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const conversation = await AssistantConversation.query()
      .where('user_id', user.id)
      .where('school_id', ctx.school.id)
      .where('channel', 'copilot')
      .orderBy('id', 'desc')
      .first()
    const messages = conversation
      ? await AssistantMessage.query()
          .where('conversation_id', conversation.id)
          .orderBy('id', 'desc')
          .limit(60)
      : []
    messages.reverse()
    return ctx.serialize({
      enabled: isAiConfigured(),
      conversationId: conversation?.id ?? null,
      messages: messages.map((m) => this.serialize(m)),
      suggestions: [
        'Give me a quick overview of the school this term',
        'Which classes have the worst attendance this month?',
        'How much in fees is still outstanding, and who owes the most?',
        'Which subjects are students struggling with most?',
        'Which exams are waiting for my review?',
        'Draft a reminder to parents with overdue fees',
        'Draft an announcement about the mid-term break',
      ],
    })
  }

  /** POST /copilot/messages { message, conversationId? } */
  async send(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const message = String(ctx.request.input('message') ?? '').trim()
    if (!message) return ctx.response.badRequest({ message: 'Please type a question.' })
    if (message.length > 2000) {
      return ctx.response.badRequest({ message: 'Please keep it under 2000 characters.' })
    }
    const id = Number(ctx.request.input('conversationId')) || null
    let conversation = id
      ? await AssistantConversation.query()
          .where('id', id)
          .where('user_id', user.id)
          .where('school_id', ctx.school.id)
          .where('channel', 'copilot')
          .first()
      : null
    if (!conversation) {
      conversation = await AssistantConversation.create({
        schoolId: ctx.school.id,
        userId: user.id,
        channel: 'copilot',
        title: null,
      })
    }
    try {
      const { reply, userMessage } = await runCopilot({ user, school: ctx.school, conversation, message })
      return ctx.serialize({
        conversationId: conversation.id,
        userMessage: this.serialize(userMessage),
        reply: this.serialize(reply),
      })
    } catch (e) {
      if (e instanceof AiError) {
        return ctx.response
          .status(e.status)
          .send({ message: e.message, conversationId: conversation.id })
      }
      throw e
    }
  }

  /** POST /copilot/messages/:messageId/actions/:index - admin confirms a card. */
  async execute(ctx: HttpContext) {
    const user = ctx.auth.getUserOrFail()
    const message = await AssistantMessage.query()
      .where('id', Number(ctx.params.messageId))
      .where('role', 'assistant')
      .first()
    const owned =
      message &&
      (await AssistantConversation.query()
        .where('id', message.conversationId)
        .where('user_id', user.id)
        .where('school_id', ctx.school.id)
        .where('channel', 'copilot')
        .first())
    if (!message || !owned) return ctx.response.notFound({ message: 'Action not found' })

    const index = Number(ctx.params.index)
    const actions = [...(message.meta?.actions ?? [])]
    const action = actions[index]
    if (!action) return ctx.response.notFound({ message: 'Action not found' })
    if (action.doneAt) {
      return ctx.response.conflict({ message: 'This action has already been done.', action })
    }

    let result: Record<string, unknown>
    if (action.type === 'announcement') {
      // Saved as an unpublished draft; the admin publishes it from Announcements.
      const row = await Announcement.create({
        schoolId: ctx.school.id,
        authorUserId: user.id,
        title: String(action.title),
        body: String(action.body),
        targetRoles: AUDIENCE_ROLES[String(action.audience)] ?? null,
        targetRules: null,
        pinned: false,
        publishedAt: null,
      })
      result = { announcementId: row.id, status: 'draft' }
    } else if (action.type === 'fee_reminder') {
      // Recomputed now so families who paid since the preview are skipped.
      const targets = await feeReminderTargets(ctx.school.id, {
        classIds: (action.classIds as number[] | null) ?? null,
        minBalanceNaira: (action.minBalanceNaira as number | null) ?? null,
        onlyOverdue: action.onlyOverdue === true,
      })
      let recipients = 0
      for (const t of targets) {
        const audience = await studentAudience(t.student.id)
        if (audience.length === 0) continue
        recipients += audience.length
        await notifyUsers(audience, {
          schoolId: ctx.school.id,
          kind: 'fee_reminder',
          title: 'School fees reminder',
          body: `${String(action.message)}\n\nOutstanding for ${t.student.firstName}: ${naira(t.balanceKobo)}.`,
          data: { kind: 'fee_reminder', studentId: t.student.id, href: '/portal' },
        })
      }
      result = { students: targets.length, notificationsSent: recipients }
    } else {
      return ctx.response.badRequest({ message: 'Unknown action' })
    }

    actions[index] = { ...action, doneAt: DateTime.now().toISO()!, result }
    message.meta = { ...(message.meta ?? {}), actions }
    await message.save()
    return ctx.serialize({ action: actions[index] })
  }
}
