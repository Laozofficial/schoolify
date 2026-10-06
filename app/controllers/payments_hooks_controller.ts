import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import Integration from '#models/integration'
import School from '#models/school'
import { paymentFor } from '#services/integrations/extra_providers'
import { providerCtx } from '#services/integrations/store'
import { parseReference, recordOnlinePayment } from '#services/online_payments'

/**
 * Webhook for a school's own Paystack or Flutterwave account. The token in
 * the URL picks the connection; the provider signature proves the sender;
 * and the amount is re-checked with the provider before anything is saved.
 */
export default class PaymentsHooksController {
  async receive({ params, request, response }: HttpContext) {
    const row = await Integration.query().where('hook_token', String(params.token)).where('kind', 'payments').first()
    if (!row) return response.notFound({ message: 'Unknown webhook' })
    const adapter = paymentFor(row.provider)
    const school = await School.find(row.schoolId)
    if (!adapter || !school) return response.ok({ received: true })
    const ctx = providerCtx(row, school)

    const raw = request.raw() ?? JSON.stringify(request.body())
    if (!adapter.verifyWebhook(ctx, raw, request.headers() as Record<string, string | undefined>)) {
      return response.unauthorized({ message: 'Invalid signature' })
    }

    const reference = adapter.successReference(request.body())
    if (!reference) return response.ok({ received: true })
    const ref = parseReference(reference)
    // Only references this school created for its own invoices.
    if (!ref || ref.schoolId !== row.schoolId) return response.ok({ received: true, note: 'not a Schoolify reference' })

    try {
      const v = await adapter.verify(ctx, reference)
      if (!v.success || v.amountKobo <= 0) return response.ok({ received: true, note: 'not successful' })
      const status = await recordOnlinePayment({ schoolId: row.schoolId, invoiceId: ref.invoiceId, reference, amountKobo: v.amountKobo })
      return response.ok({ received: true, status })
    } catch (e) {
      logger.error({ err: e, provider: row.provider }, 'payment webhook failed')
      // 500 so the provider retries later.
      return response.internalServerError({ message: 'Could not confirm payment yet' })
    }
  }
}
