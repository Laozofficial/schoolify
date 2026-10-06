import { MessageCampaignSchema } from '#database/schema'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { jsonbConsume, jsonbPrepare } from '#models/_jsonb'
import User from '#models/user'

export default class MessageCampaign extends MessageCampaignSchema {
  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare channels: string[]

  @column({ prepare: jsonbPrepare, consume: jsonbConsume })
  declare audience: Record<string, unknown> | null

  @belongsTo(() => User, { foreignKey: 'createdByUserId' })
  declare createdBy: BelongsTo<typeof User>
}
