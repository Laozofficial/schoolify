import { ParentStudentSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from '#models/user'
import Student from '#models/student'

export default class ParentStudent extends ParentStudentSchema {
  @belongsTo(() => User, { foreignKey: 'parentUserId' })
  declare parent: BelongsTo<typeof User>

  @belongsTo(() => Student)
  declare student: BelongsTo<typeof Student>
}
