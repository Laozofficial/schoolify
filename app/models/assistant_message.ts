import { AssistantMessageSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbPrepare, jsonbConsume } from '#models/_jsonb'

export default class AssistantMessage extends AssistantMessageSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare meta: {
    tools?: string[]
    /** Copilot action cards; `doneAt` is set once an admin executes one. */
    actions?: Array<Record<string, unknown> & { type: string; doneAt?: string; result?: unknown }>
  } | null
}
