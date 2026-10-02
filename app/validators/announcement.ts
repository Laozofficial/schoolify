import vine from '@vinejs/vine'
import { ROLES } from '#models/user_school_role'

const roleValidator = vine.enum(ROLES)
const rolesForClass = vine.enum(['parent', 'student', 'teacher'] as const)

/** Discriminated union - Vine matches by the `type` field. */
const ruleValidator = vine.union([
  vine.union.if(
    (v) => (v as { type?: string }).type === 'role',
    vine.object({ type: vine.literal('role'), role: roleValidator })
  ),
  vine.union.if(
    (v) => (v as { type?: string }).type === 'role_in_class',
    vine.object({
      type: vine.literal('role_in_class'),
      role: rolesForClass,
      classId: vine.number().positive(),
    })
  ),
  vine.union.if(
    (v) => (v as { type?: string }).type === 'teachers_of_subject',
    vine.object({
      type: vine.literal('teachers_of_subject'),
      subjectId: vine.number().positive(),
    })
  ),
  vine.union.if(
    (v) => (v as { type?: string }).type === 'users',
    vine.object({
      type: vine.literal('users'),
      userIds: vine.array(vine.number().positive()).minLength(1),
    })
  ),
])

export const createAnnouncementValidator = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200),
    body: vine.string().trim().minLength(1).maxLength(10_000),
    targetRoles: vine.array(roleValidator).optional(),
    targetRules: vine.array(ruleValidator).optional(),
    pinned: vine.boolean().optional(),
    publish: vine.boolean().optional(),
  })
)

export const updateAnnouncementValidator = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200).optional(),
    body: vine.string().trim().minLength(1).maxLength(10_000).optional(),
    targetRoles: vine.array(roleValidator).nullable().optional(),
    targetRules: vine.array(ruleValidator).nullable().optional(),
    pinned: vine.boolean().optional(),
    publish: vine.boolean().optional(),
  })
)
