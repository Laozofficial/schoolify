import { DateTime } from 'luxon'
import type User from '#models/user'
import type School from '#models/school'
import AssistantConversation from '#models/assistant_conversation'
import AssistantMessage from '#models/assistant_message'
import { aiChatWithTools, AiError, type ChatMessage } from '#services/ai'
import { familyAccess } from '#services/family_access'
import { FAMILY_TOOLS, familyToolExecutor } from '#services/assistant/family_tools'

/**
 * The family assistant: answers parents and students from the school's own
 * data through read-only tools. Grounding contract: every fact in a reply
 * must come from a tool result in this conversation.
 */

export const DAILY_MESSAGE_LIMIT = 60
const HISTORY_MESSAGES = 16

export type Channel = 'web' | 'whatsapp'

function noEmDash(s: string): string {
  return s.replace(/\s*\u2014\s*/g, ', ').replace(/\u2013/g, '-')
}

function systemPrompt(opts: {
  schoolName: string
  userName: string
  who: string
  children: string
  channel: Channel
}) {
  const now = DateTime.now().setZone('Africa/Lagos')
  const format =
    opts.channel === 'whatsapp'
      ? 'You are replying on WhatsApp: plain text only, no markdown headings, tables or links. Use *single asterisks* for bold on at most one or two key figures, and short lines.'
      : 'Use short "- " bullet lists when listing several items. Bold sparingly: at most one or two key figures or names per reply, never whole sentences. No tables or headings.'
  return [
    `You are the friendly school assistant for ${opts.schoolName}, helping ${opts.userName} (${opts.who}).`,
    `Today is ${now.toFormat('cccc d LLLL yyyy')}, ${now.toFormat('h:mm a')} in Lagos.`,
    `Students this user can ask about:\n${opts.children}`,
    '',
    'Rules:',
    '1. Ground every fact in a tool result from this conversation. Never guess or invent scores, dates, amounts, names, codes or events. If a tool returns nothing or says something is unavailable, say so plainly. Never add, subtract or average numbers yourself; use the totals the tools return.',
    '2. Call tools whenever the question needs school data. You may call several at once. Prefer fresh tool calls over earlier answers when the question is about now.',
    '3. If there are several children and the question does not say which, answer for each child briefly, or ask if that would be long.',
    '4. You can only read information. You cannot pay fees, change records, excuse absences, submit work or message teachers. Say where in the portal to do it, or to contact the school office.',
    '5. Only discuss the students listed above. Politely refuse questions about any other student.',
    '6. Keep replies short and warm: one to four sentences or a short list. Quote money exactly as the tools give it.',
    '7. For homework help you may explain a concept briefly, but never give answers to graded assignments or exams.',
    '8. Off-topic requests: politely bring the conversation back to school matters.',
    `9. ${format}`,
    '10. Write in clear British English. Never use em dashes.',
  ].join('\n')
}

export async function runFamilyAssistant(opts: {
  user: User
  school: School
  conversation: AssistantConversation
  message: string
  channel: Channel
  externalId?: string | null
}): Promise<{ reply: AssistantMessage; userMessage: AssistantMessage; toolsUsed: string[] }> {
  const { user, school, conversation, channel } = opts
  const text = opts.message.trim().slice(0, 1000)
  if (!text) throw new AiError('Please type a question.', 422)

  const access = await familyAccess(user, school.id)
  if (access.students.length === 0) {
    throw new AiError('No student is linked to this account yet. Please contact the school office.', 403)
  }

  // Fair-use cap per user per day, across channels.
  const since = DateTime.now().minus({ hours: 24 })
  const used = await AssistantMessage.query()
    .where('role', 'user')
    .where('created_at', '>=', since.toSQL()!)
    .whereIn(
      'conversation_id',
      AssistantConversation.query().select('id').where('user_id', user.id).where('school_id', school.id)
    )
    .count('* as total')
  if (Number(used[0].$extras.total) >= DAILY_MESSAGE_LIMIT) {
    throw new AiError(`You have reached today's limit of ${DAILY_MESSAGE_LIMIT} questions. Please try again tomorrow.`, 429)
  }

  // Load history BEFORE saving the new message so it is not duplicated.
  const history = await AssistantMessage.query()
    .where('conversation_id', conversation.id)
    .orderBy('id', 'desc')
    .limit(HISTORY_MESSAGES)
  history.reverse()

  // Saving the user message first also dedupes WhatsApp retries via the
  // unique external_id (a duplicate insert throws and we stop here).
  const userMessage = await AssistantMessage.create({
    conversationId: conversation.id,
    role: 'user',
    content: text,
    externalId: opts.externalId ?? null,
    meta: null,
  })

  const children = access.students
    .map(
      (s) =>
        `- ${[s.firstName, s.lastName].filter(Boolean).join(' ')} (studentId ${s.id}), ${s.schoolClass?.name ?? 'no class'}${access.wardIds.has(s.id) ? '' : ' (this is the user themself)'}`
    )
    .join('\n')
  const who = access.isParent ? (access.isStudent ? 'a parent and student' : 'a parent') : 'a student'

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt({
        schoolName: school.name,
        userName: user.fullName || 'there',
        who,
        children,
        channel,
      }),
    },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }) as ChatMessage),
    { role: 'user', content: text },
  ]

  const { text: answer, toolsUsed } = await aiChatWithTools({
    schoolId: school.id,
    userId: user.id,
    feature: `assistant_${channel}`,
    messages,
    tools: FAMILY_TOOLS,
    execute: familyToolExecutor(user, school.id, access),
  })

  const reply = await AssistantMessage.create({
    conversationId: conversation.id,
    role: 'assistant',
    content: noEmDash(answer),
    meta: { tools: [...new Set(toolsUsed)] },
  })
  if (!conversation.title) {
    conversation.title = text.slice(0, 80)
  }
  conversation.updatedAt = DateTime.now()
  await conversation.save()

  return { reply, userMessage, toolsUsed }
}
