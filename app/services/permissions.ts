import type User from '#models/user'
import type { Role } from '#models/user_school_role'
import PermissionOverride from '#models/permission_override'

/**
 * Granular RBAC layer. A staff member's ability to perform an action on a
 * resource is resolved as:
 *
 *   1. super_admin is always allowed (immune - prevents lockout).
 *   2. An explicit per-user override (allow|deny) wins over the role default.
 *   3. Otherwise the union of the user's role defaults applies (any role
 *      that allows it => allowed).
 *
 * "Grants override role" means a `deny` override can revoke access a role
 * would normally grant, and an `allow` override can grant access a role
 * would normally lack.
 */

export type Action = 'create' | 'read' | 'update' | 'delete'
export const ACTIONS: Action[] = ['create', 'read', 'update', 'delete']

/**
 * Resources under permission control in this pass (core modules). Each has
 * a label for the admin UI. Extend this list as more modules are enrolled.
 */
export const RESOURCES = [
  { key: 'students', label: 'Students' },
  { key: 'subjects', label: 'Subjects' },
  { key: 'classes', label: 'Classes' },
  { key: 'timetable', label: 'Timetable' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'results', label: 'Results' },
  { key: 'exams', label: 'Exams / CBT' },
] as const

export type ResourceKey = (typeof RESOURCES)[number]['key']
export const RESOURCE_KEYS = RESOURCES.map((r) => r.key) as ResourceKey[]

/**
 * Role default matrix. `true` = that role may do the action on the resource
 * by default. Anything not listed defaults to false. super_admin/admin get
 * blanket access via the resolver, so they're omitted here.
 */
type RoleMatrix = Partial<Record<Role, Partial<Record<ResourceKey, Action[]>>>>

const ROLE_DEFAULTS: RoleMatrix = {
  teacher: {
    students: ['read'],
    subjects: ['read'],
    classes: ['read'],
    timetable: ['read'],
    attendance: ['create', 'read', 'update'],
    results: ['create', 'read', 'update'],
    exams: ['create', 'read', 'update', 'delete'],
  },
  accountant: {
    students: ['read'],
    classes: ['read'],
  },
  non_academic_staff: {
    students: ['read'],
    classes: ['read'],
  },
  parent: {},
  student: {},
}

function roleAllows(role: Role, resource: ResourceKey, action: Action): boolean {
  if (role === 'super_admin' || role === 'admin') return true
  const forRole = ROLE_DEFAULTS[role]
  const actions = forRole?.[resource]
  return !!actions?.includes(action)
}

/** True when any of the roles grants (resource, action) by default. */
export function roleDefaultAllows(
  roles: Role[],
  resource: ResourceKey,
  action: Action
): boolean {
  return roles.some((r) => roleAllows(r, resource, action))
}

export interface EffectivePermission {
  resource: ResourceKey
  action: Action
  allowed: boolean
  /** How the decision was reached, for the admin UI. */
  source: 'super_admin' | 'override' | 'role'
  /** The stored override effect if one exists (else null = inherit). */
  override: 'allow' | 'deny' | null
}

/**
 * Resolve the full effective matrix for a user at a school, including which
 * cells come from overrides vs role defaults. Used by the admin editor and
 * the `/account/permissions` self endpoint.
 */
export async function effectiveMatrix(
  user: User,
  schoolId: number
): Promise<EffectivePermission[]> {
  const roles = await user.rolesAtSchool(schoolId)
  const isSuper = roles.includes('super_admin')
  const overrides = await PermissionOverride.query()
    .where('user_id', user.id)
    .where('school_id', schoolId)
  const ovMap = new Map<string, 'allow' | 'deny'>()
  for (const o of overrides) {
    ovMap.set(`${o.resource}:${o.action}`, o.effect as 'allow' | 'deny')
  }

  const out: EffectivePermission[] = []
  for (const r of RESOURCE_KEYS) {
    for (const a of ACTIONS) {
      const ov = ovMap.get(`${r}:${a}`) ?? null
      let allowed: boolean
      let source: EffectivePermission['source']
      if (isSuper) {
        allowed = true
        source = 'super_admin'
      } else if (ov) {
        allowed = ov === 'allow'
        source = 'override'
      } else {
        allowed = roleDefaultAllows(roles, r, a)
        source = 'role'
      }
      out.push({ resource: r, action: a, allowed, source, override: ov })
    }
  }
  return out
}

/**
 * Single permission check used by middleware. super_admin is immune; a
 * stored override wins; else fall back to role defaults.
 */
export async function can(
  user: User,
  schoolId: number,
  resource: ResourceKey,
  action: Action
): Promise<boolean> {
  const roles = await user.rolesAtSchool(schoolId)
  if (roles.includes('super_admin')) return true
  const ov = await PermissionOverride.query()
    .where('user_id', user.id)
    .where('school_id', schoolId)
    .where('resource', resource)
    .where('action', action)
    .first()
  if (ov) return ov.effect === 'allow'
  return roleDefaultAllows(roles, resource, action)
}
