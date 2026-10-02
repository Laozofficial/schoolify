import { AssistantConversationSchema } from '#database/schema'
import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import AssistantMessage from '#models/assistant_message'

export default class AssistantConversation extends AssistantConversationSchema {
  @hasMany(() => AssistantMessage, { foreignKey: 'conversationId' })
  declare messages: HasMany<typeof AssistantMessage>
}
