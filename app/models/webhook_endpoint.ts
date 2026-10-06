import { WebhookEndpointSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'

export default class WebhookEndpoint extends WebhookEndpointSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare events: string[]

  /** Encrypted signing secret. Never serialised. */
  @column({ serializeAs: null })
  declare secret: string
}
