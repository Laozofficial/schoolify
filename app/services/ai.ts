import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import AiCall from '#models/ai_call'
import { creditsBlockMessage, chargeUsage } from '#services/ai_credits'

/**
 * Thin OpenAI client for the portal's AI features. Every call:
 * - asks for STRICT structured JSON (json_schema) so callers get typed data,
 *   never free text they have to parse,
 * - is logged to `ai_calls` (feature, tokens, latency, status) for cost
 *   visibility,
 * - fails with an AiError carrying an HTTP-ish status so controllers can
 *   return a clean 503/502 instead of a stack trace.
 *
 * Privacy: callers must send the minimum needed (first names, numbers),
 * never full student profiles.
 */

export type Effort = 'none' | 'low' | 'medium' | 'high'

export class AiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const RETRY_DELAYS_MS = [0, 1000, 3000]
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * POST to OpenAI with retry + backoff on transient failures: network errors
 * and 429/5xx responses. Timeouts are NOT retried (that would only double
 * the wait). Returns the final response and parsed JSON.
 */
async function postWithRetry(key: string, body: unknown, timeoutMs: number) {
  let lastError: unknown
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json = (await res.json().catch(() => null)) as any
      if (RETRYABLE_STATUS.has(res.status)) {
        lastError = new AiError(
          json?.error?.message ?? `AI request failed (${res.status})`,
          res.status === 429 ? 429 : 502
        )
        continue
      }
      return { res, json }
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw e
      lastError = e
    }
  }
  throw lastError
}

export function isAiConfigured(): boolean {
  return !!env.get('OPENAI_API_KEY')?.release()
}

export function aiModel(): string {
  return env.get('OPENAI_MODEL') ?? 'gpt-5.4'
}

interface AiJsonInput {
  schoolId: number | null
  userId: number | null
  feature: string
  system: string
  /** Plain text, or multi-part content (text + image_url parts for vision). */
  user: string | Array<Record<string, unknown>>
  /** JSON Schema for the response (strict mode: every property required,
   * additionalProperties false at every level). */
  schema: Record<string, unknown>
  schemaName: string
  effort?: Effort
  maxTokens?: number
}

export async function aiJson<T>(input: AiJsonInput): Promise<T> {
  const key = env.get('OPENAI_API_KEY')?.release()
  if (!key) throw new AiError('AI is not configured on this server yet.', 503)
  const blocked = await creditsBlockMessage(input.schoolId)
  if (blocked) throw new AiError(blocked, 402)

  const model = aiModel()
  const effort = input.effort ?? env.get('OPENAI_REASONING_EFFORT') ?? 'medium'
  const started = Date.now()

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: input.schemaName, strict: true, schema: input.schema },
    },
    max_completion_tokens: input.maxTokens ?? 8000,
  }
  // No tools are used here, so reasoning_effort is accepted by the model.
  if (effort !== 'none') body.reasoning_effort = effort

  let promptTokens = 0
  let completionTokens = 0
  try {
    const { res, json } = await postWithRetry(key, body, 120_000)
    if (!res.ok) {
      const msg = json?.error?.message ?? `AI request failed (${res.status})`
      throw new AiError(msg, res.status === 429 ? 429 : 502)
    }
    promptTokens = json?.usage?.prompt_tokens ?? 0
    completionTokens = json?.usage?.completion_tokens ?? 0

    const choice = json?.choices?.[0]
    if (choice?.message?.refusal) throw new AiError('The AI declined this request.', 422)
    if (choice?.finish_reason === 'length') {
      throw new AiError('The AI response was cut short. Try a smaller request.', 502)
    }
    const content = choice?.message?.content
    if (!content) throw new AiError('The AI returned an empty response.', 502)

    const parsed = JSON.parse(content) as T
    await log(input, model, promptTokens, completionTokens, started, 'ok', null)
    return parsed
  } catch (e) {
    if (!(e instanceof AiError)) logger.warn({ err: e, feature: input.feature }, 'ai call failed')
    const err =
      e instanceof AiError
        ? e
        : new AiError(
            (e as Error)?.name === 'TimeoutError'
              ? 'The AI took too long to respond. Please try again.'
              : 'Could not reach the AI service.',
            502
          )
    await log(input, model, promptTokens, completionTokens, started, 'error', err.message)
    throw err
  }
}

async function log(
  input: Pick<AiJsonInput, 'schoolId' | 'userId' | 'feature'>,
  model: string,
  promptTokens: number,
  completionTokens: number,
  started: number,
  status: 'ok' | 'error',
  error: string | null
) {
  let callId: number | null = null
  try {
    const row = await AiCall.create({
      schoolId: input.schoolId,
      userId: input.userId,
      feature: input.feature,
      model,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - started,
      status,
      error,
    })
    callId = row.id
  } catch {
    // Logging must never break the feature.
  }
  // Tokens are billed whether or not the answer was usable: the AI did the work.
  await chargeUsage({ schoolId: input.schoolId, userId: input.userId, feature: input.feature, aiCallId: callId, promptTokens, completionTokens })
}

/* -------------------------------------------------------------------------- */
/* Tool calling (agent loop)                                                  */
/* -------------------------------------------------------------------------- */

export interface AiTool {
  name: string
  description: string
  /** JSON Schema (strict: every property required, nullable for optional). */
  parameters: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'tool'; content: string; tool_call_id: string }

interface ToolLoopInput {
  schoolId: number | null
  userId: number | null
  feature: string
  messages: ChatMessage[]
  tools: AiTool[]
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  maxSteps?: number
  maxTokens?: number
}

/**
 * ReAct-style loop: the model may call tools (read-only data lookups),
 * sees their JSON results, and finally answers in plain text. Tool errors
 * are returned to the model as data, never thrown at the user.
 *
 * Note: reasoning_effort is deliberately NOT sent - this model rejects it
 * on chat completions whenever tools are attached.
 */
export async function aiChatWithTools(
  input: ToolLoopInput
): Promise<{ text: string; toolsUsed: string[] }> {
  const key = env.get('OPENAI_API_KEY')?.release()
  if (!key) throw new AiError('AI is not configured on this server yet.', 503)
  const blocked = await creditsBlockMessage(input.schoolId)
  if (blocked) throw new AiError(blocked, 402)
  const model = aiModel()
  const messages: ChatMessage[] = [...input.messages]
  const toolsUsed: string[] = []
  const maxSteps = input.maxSteps ?? 6
  const tools = input.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
  }))

  for (let step = 0; step <= maxSteps; step++) {
    // On the last step force a text answer so the loop always terminates.
    const finalStep = step === maxSteps
    const started = Date.now()
    let promptTokens = 0
    let completionTokens = 0
    let json: any
    try {
      const sent = await postWithRetry(
        key,
        {
          model,
          messages,
          tools,
          tool_choice: finalStep ? 'none' : 'auto',
          max_completion_tokens: input.maxTokens ?? 2000,
        },
        90_000
      )
      const res = sent.res
      json = sent.json
      if (!res.ok) {
        throw new AiError(json?.error?.message ?? `AI request failed (${res.status})`, res.status === 429 ? 429 : 502)
      }
      promptTokens = json?.usage?.prompt_tokens ?? 0
      completionTokens = json?.usage?.completion_tokens ?? 0
      await log(input, model, promptTokens, completionTokens, started, 'ok', null)
    } catch (e) {
      if (!(e instanceof AiError)) logger.warn({ err: e, feature: input.feature }, 'ai tool loop call failed')
      const err =
        e instanceof AiError
          ? e
          : new AiError(
              (e as Error)?.name === 'TimeoutError'
                ? 'The assistant took too long to respond. Please try again.'
                : 'Could not reach the AI service.',
              502
            )
      await log(input, model, promptTokens, completionTokens, started, 'error', err.message)
      throw err
    }

    const msg = json?.choices?.[0]?.message
    const calls: any[] = msg?.tool_calls ?? []
    if (calls.length === 0 || finalStep) {
      const text = String(msg?.content ?? '').trim()
      if (!text) throw new AiError('The assistant returned an empty answer.', 502)
      return { text, toolsUsed }
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
    const results = await Promise.all(
      calls.map(async (call) => {
        const name = call?.function?.name as string
        toolsUsed.push(name)
        let out: unknown
        try {
          const args = JSON.parse(call?.function?.arguments || '{}')
          out = await input.execute(name, args)
        } catch (e) {
          out = { error: (e as Error)?.message ?? 'Tool failed' }
        }
        let content = JSON.stringify(out ?? null)
        if (content.length > 12000) content = content.slice(0, 12000) + '... [truncated]'
        return { role: 'tool' as const, tool_call_id: call.id as string, content }
      })
    )
    messages.push(...results)
  }
  throw new AiError('The assistant could not finish. Please try again.', 502)
}
