import { DateTime } from 'luxon'
import type User from '#models/user'
import type School from '#models/school'
import AssistantConversation from '#models/assistant_conversation'
import AssistantMessage from '#models/assistant_message'
import { aiChatWithTools, AiError, type ChatMessage } from '#services/ai'
import { noEmDash } from '#services/question_generator'
import { COPILOT_TOOLS, copilotToolExecutor, type CopilotAction } from '#services/copilot/copilot_tools'

/**
 * Admin copilot: plain-English questions over school-wide data, plus
 * drafting announcements and fee reminders as action cards that an admin
 * must confirm. Same grounding contract as the family assistant.
 */

const HISTORY_MESSAGES = 16
export const COPILOT_DAILY_LIMIT = 150

function systemPrompt(schoolName: string, userName: string) {
  const now = DateTime.now().setZone('Africa/Lagos')
  return [
    `You are the operations copilot for ${schoolName}, helping ${userName}, a school administrator.`,
    `Today is ${now.toFormat('cccc d LLLL yyyy')}, ${now.toFormat('h:mm a')} in Lagos.`,
    '',
    'Rules:',
    '1. Ground every number, name and fact in a tool result from this conversation. Never guess. If data is missing, say so.',
    '2. Use the totals, percentages and amounts the tools return; do not add or average numbers yourself.',
    '3. Call several tools at once when useful. Resolve class names with list_classes and students with find_students.',
    '4. To draft an announcement or a fee reminder, call propose_announcement or propose_fee_reminder. Then say a card is ready below for them to review. Do not start with "Done". NEVER say anything was published or sent: only the admin can do that, by clicking the button on the card.',
    '5. Be concise and practical: lead with the answer, then a short list if helpful, then at most one suggested next step. No tables or headings. Bold at most two or three key figures per reply, never whole phrases or labels.',
    '6. Treat student information as confidential and only discuss what the admin asks about.',
    '7. Write in clear British English. Never use em dashes.',
  ].join('\n')
}

export async function runCopilot(opts: {
  user: User
  school: School
  conversation: AssistantConversation
  message: string
}) {
  const { user, school, conversation } = opts
  const text = opts.message.trim().slice(0, 2000)
  if (!text) throw new AiError('Please type a question.', 422)

  const used = await AssistantMessage.query()
    .where('role', 'user')
    .where('created_at', '>=', DateTime.now().minus({ hours: 24 }).toSQL()!)
    .whereIn(
      'conversation_id',
      AssistantConversation.query()
        .select('id')
        .where('user_id', user.id)
        .where('school_id', school.id)
        .where('channel', 'copilot')
    )
    .count('* as total')
  if (Number(used[0].$extras.total) >= COPILOT_DAILY_LIMIT) {
    throw new AiError(`You have reached today's limit of ${COPILOT_DAILY_LIMIT} questions.`, 429)
  }

  const history = await AssistantMessage.query()
    .where('conversation_id', conversation.id)
    .orderBy('id', 'desc')
    .limit(HISTORY_MESSAGES)
  history.reverse()

  const userMessage = await AssistantMessage.create({
    conversationId: conversation.id,
    role: 'user',
    content: text,
    meta: null,
  })

  const actions: CopilotAction[] = []
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(school.name, user.fullName || 'there') },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }) as ChatMessage),
    { role: 'user', content: text },
  ]

  const { text: answer, toolsUsed } = await aiChatWithTools({
    schoolId: school.id,
    userId: user.id,
    feature: 'copilot',
    messages,
    tools: COPILOT_TOOLS,
    execute: copilotToolExecutor(school.id, actions),
    maxSteps: 8,
    maxTokens: 3000,
  })

  const reply = await AssistantMessage.create({
    conversationId: conversation.id,
    role: 'assistant',
    content: noEmDash(answer),
    meta: {
      tools: [...new Set(toolsUsed)],
      actions: actions.map((a) =>
        a.type === 'announcement'
          ? { ...a, title: noEmDash(a.title), body: noEmDash(a.body) }
          : { ...a, message: noEmDash(a.message) }
      ),
    },
  })
  if (!conversation.title) conversation.title = text.slice(0, 80)
  conversation.updatedAt = DateTime.now()
  await conversation.save()
  return { reply, userMessage }
}
