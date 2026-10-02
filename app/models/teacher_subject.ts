import { TeacherSubjectSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from '#models/user'
import Subject from '#models/subject'
import SchoolClass from '#models/school_class'

export default class TeacherSubject extends TeacherSubjectSchema {
  static table = 'teacher_subjects'

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @belongsTo(() => Subject)
  declare subject: BelongsTo<typeof Subject>

  @belongsTo(() => SchoolClass, { foreignKey: 'classId' })
  declare schoolClass: BelongsTo<typeof SchoolClass>
}
