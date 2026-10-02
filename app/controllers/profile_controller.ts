import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { changePasswordValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import hash from '@adonisjs/core/services/hash'

export default class ProfileController {
  async show({ auth, serialize }: HttpContext) {
    return serialize(UserTransformer.transform(auth.getUserOrFail()))
  }

  /**
   * PATCH /account/password
   * Verifies the current password, sets the new one, clears
   * `mustChangePassword`. Also revokes all other access tokens so the caller's
   * other sessions are logged out.
   */
  async changePassword({ auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const { currentPassword, newPassword } = await request.validateUsing(changePasswordValidator)

    const ok = await hash.verify(user.password, currentPassword)
    if (!ok) {
      return response.badRequest({ message: 'Current password is incorrect' })
    }

    user.password = newPassword
    user.mustChangePassword = false
    await user.save()

    // revoke every other token so other sessions are kicked out
    const currentId = user.currentAccessToken?.identifier
    const tokens = await User.accessTokens.all(user)
    for (const t of tokens) {
      if (String(t.identifier) !== String(currentId)) {
        await User.accessTokens.delete(user, t.identifier)
      }
    }

    return serialize(UserTransformer.transform(user))
  }
}
