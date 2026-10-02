import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import { deriveDefaultPassword } from '#services/user_provisioning'
import { dispatch } from '#services/queue'
import SendInviteJob from '#jobs/send_invite_job'

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  teacher: 'Teacher',
  non_academic_staff: 'Non-academic staff',
  accountant: 'Accountant',
  parent: 'Parent',
  student: 'Student',
  super_admin: 'Super admin',
}

/**
 * "Pending invitation" == a user at this school who still has
 * mustChangePassword=true and has never logged in. Once they change
 * their password (or sign in), they drop off this list.
 */
export default class InvitationsController {
  async index({ school, request, serialize }: HttpContext) {
    const qs = request.qs()
    const q = User.query()
      .where('must_change_password', true)
      .whereIn(
        'id',
        UserSchoolRole.query().select('user_id').where('school_id', school.id)
      )
      .preload('roleAssignments', (rq) => rq.where('school_id', school.id))
      .orderBy('created_at', 'desc')
    if (qs.q) {
      q.where((qq) => {
        qq.whereILike('email', `%${qs.q}%`).orWhereILike('full_name', `%${qs.q}%`)
      })
    }
    const rows = await q.limit(Math.min(Number(qs.limit ?? 200), 500))
    return serialize(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        phone: u.phone,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        roles: u.roleAssignments.map((r) => r.role),
      }))
    )
  }

  /**
   * POST /invitations/:userId/resend
   * Regenerates a temp password for the user and re-fires the invite
   * email. Only allowed while the user is still in the pending state
   * (mustChangePassword=true).
   */
  async resend({ school, params, response, serialize }: HttpContext) {
    const user = await User.find(params.userId)
    if (!user) return response.notFound({ message: 'User not found' })
    if (!user.mustChangePassword) {
      return response.badRequest({
        message: 'User already onboarded - password reset must go through the normal flow.',
      })
    }
    // Confirm the user actually belongs to this school.
    const roles = await UserSchoolRole.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
    if (roles.length === 0) {
      return response.notFound({ message: 'User not in this school' })
    }

    const tempPassword = deriveDefaultPassword(user.surname)
    user.password = tempPassword
    user.mustChangePassword = true
    await user.save()

    const roleLabel = roles
      .map((r) => ROLE_LABELS[r.role] ?? r.role)
      .join(', ')
    await dispatch(SendInviteJob, {
      to: user.email,
      fullName: user.fullName,
      tempPassword,
      schoolName: school.name,
      roleLabel,
    })

    return serialize({ id: user.id, email: user.email, tempPassword })
  }

  /**
   * DELETE /invitations/:userId
   * Cancels a pending invite by revoking every school role for the
   * user AND destroying the user itself if they have no other school
   * membership. Non-pending users are refused.
   */
  async cancel({ school, params, response }: HttpContext) {
    const user = await User.find(params.userId)
    if (!user) return response.notFound({ message: 'User not found' })
    if (!user.mustChangePassword) {
      return response.badRequest({ message: 'User already onboarded' })
    }
    await UserSchoolRole.query()
      .where('user_id', user.id)
      .where('school_id', school.id)
      .delete()
    const remaining = await UserSchoolRole.query()
      .where('user_id', user.id)
      .count('* as total')
    if (Number(remaining[0].$extras.total) === 0) {
      await user.delete()
    }
    return response.noContent()
  }
}
