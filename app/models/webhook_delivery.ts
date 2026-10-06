import { WebhookDeliverySchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'

export default class WebhookDelivery extends WebhookDeliverySchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare payload: Record<string, unknown>
}
