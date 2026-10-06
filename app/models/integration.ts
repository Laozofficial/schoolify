import { IntegrationSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'

export default class Integration extends IntegrationSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare config: Record<string, unknown> | null

  /** Encrypted JSON blob. Never serialise this to clients. */
  @column({ serializeAs: null })
  declare secrets: string | null
}
