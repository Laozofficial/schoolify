import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Integration from '#models/integration'
import { PROVIDERS, providerFor } from '#services/integrations/providers'
import {
  decryptSecrets,
  encryptSecrets,
  hookUrlFor,
  maskSecret,
  newHookToken,
  providerCtx,
} from '#services/integrations/store'
import {
  createIntegrationValidator,
  testIntegrationValidator,
  updateIntegrationValidator,
} from '#validators/messaging'

/**
 * A school's own provider accounts (SMS, email, WhatsApp). Admin only.
 * Secret values never leave the server: responses carry a masked hint.
 */
export default class IntegrationsController {
  async catalog({ serialize }: HttpContext) {
    return serialize(PROVIDERS.map((p) => p.def))
  }

  async index({ school, serialize }: HttpContext) {
    const rows = await Integration.query().where('school_id', school.id).orderBy('kind').orderBy('id')
    return serialize(rows.map((r) => this.serialize(r)))
  }

  async store({ school, auth, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createIntegrationValidator)
    const adapter = providerFor(payload.provider)
    if (!adapter) return response.badRequest({ message: 'Unknown provider' })

    const { config, secrets, missing } = this.split(adapter.def.fields, payload.values, {})
    if (missing.length) return response.unprocessableEntity({ message: `Missing: ${missing.join(', ')}` })

    const hasAny = await Integration.query()
      .where('school_id', school.id)
      .where('kind', adapter.def.kind)
      .first()

    const row = await Integration.create({
      schoolId: school.id,
      kind: adapter.def.kind,
      provider: adapter.def.key,
      label: payload.label ?? null,
      status: 'connected',
      config,
      secrets: encryptSecrets(secrets),
      isDefault: payload.isDefault ?? !hasAny,
      hookToken: newHookToken(),
      createdByUserId: auth.user?.id ?? null,
    })
    if (row.isDefault) await this.clearOtherDefaults(row)
    await this.runTest(row, school)
    response.status(201)
    return serialize(this.serialize(row))
  }

  async update({ school, params, request, response, serialize }: HttpContext) {
    const row = await this.find(school.id, params.id)
    if (!row) return response.notFound({ message: 'Connection not found' })
    const adapter = providerFor(row.provider)
    if (!adapter) return response.badRequest({ message: 'Unknown provider' })
    const payload = await request.validateUsing(updateIntegrationValidator)

    if (payload.values) {
      const current = decryptSecrets(row.secrets)
      const { config, secrets, missing } = this.split(adapter.def.fields, payload.values, current)
      if (missing.length) return response.unprocessableEntity({ message: `Missing: ${missing.join(', ')}` })
      row.config = config
      row.secrets = encryptSecrets(secrets)
    }
    if (payload.label !== undefined) row.label = payload.label ?? null
    if (payload.status) row.status = payload.status
    if (payload.isDefault !== undefined) row.isDefault = payload.isDefault
    await row.save()
    if (row.isDefault) await this.clearOtherDefaults(row)
    if (payload.values && row.status !== 'disabled') await this.runTest(row, school)
    return serialize(this.serialize(row))
  }

  async destroy({ school, params, response }: HttpContext) {
    const row = await this.find(school.id, params.id)
    if (!row) return response.notFound({ message: 'Connection not found' })
    await row.delete()
    if (row.isDefault) {
      const next = await Integration.query()
        .where('school_id', school.id)
        .where('kind', row.kind)
        .whereNot('status', 'disabled')
        .orderBy('id')
        .first()
      if (next) {
        next.isDefault = true
        await next.save()
      }
    }
    return response.noContent()
  }

  /** Check credentials, and optionally send a real message to `to`. */
  async test({ school, params, request, response, serialize }: HttpContext) {
    const row = await this.find(school.id, params.id)
    if (!row) return response.notFound({ message: 'Connection not found' })
    const { to } = await request.validateUsing(testIntegrationValidator)
    const result = await this.runTest(row, school)
    let sent: string | null = null
    if (result.ok && to) {
      const adapter = providerFor(row.provider)!
      try {
        await adapter.send(providerCtx(row, school), {
          to,
          subject: `Test message from ${school.name}`,
          body: `This is a test message from ${school.name} on Schoolify. If you received it, the ${adapter.def.name} connection works.`,
        })
        sent = `Test message sent to ${to}.`
      } catch (e) {
        row.status = 'error'
        row.lastError = String((e as Error).message).slice(0, 500)
        await row.save()
        return serialize({ ok: false, message: row.lastError, integration: this.serialize(row) })
      }
    }
    return serialize({ ...result, message: [result.message, sent].filter(Boolean).join(' '), integration: this.serialize(row) })
  }

  private async runTest(row: Integration, school: { name: string }) {
    const adapter = providerFor(row.provider)
    if (!adapter) return { ok: false, message: 'Unknown provider' }
    try {
      const message = await adapter.test(providerCtx(row, school))
      row.status = row.status === 'disabled' ? 'disabled' : 'connected'
      row.lastError = null
      row.lastTestedAt = DateTime.now()
      await row.save()
      return { ok: true, message }
    } catch (e) {
      row.status = row.status === 'disabled' ? 'disabled' : 'error'
      row.lastError = String((e as Error).message).slice(0, 500)
      row.lastTestedAt = DateTime.now()
      await row.save()
      return { ok: false, message: row.lastError }
    }
  }

  private split(
    fields: { key: string; secret?: boolean; required?: boolean; label: string }[],
    values: Record<string, string>,
    currentSecrets: Record<string, string>
  ) {
    const config: Record<string, string> = {}
    const secrets: Record<string, string> = {}
    const missing: string[] = []
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim()
      if (f.secret) {
        const keep = v || currentSecrets[f.key] || ''
        if (keep) secrets[f.key] = keep
        if (f.required && !keep) missing.push(f.label)
      } else {
        if (v) config[f.key] = v
        if (f.required && !v) missing.push(f.label)
      }
    }
    return { config, secrets, missing }
  }

  private async clearOtherDefaults(row: Integration) {
    await Integration.query()
      .where('school_id', row.schoolId)
      .where('kind', row.kind)
      .whereNot('id', row.id)
      .update({ is_default: false })
  }

  private find(schoolId: number, id: unknown) {
    return Integration.query().where('school_id', schoolId).where('id', Number(id)).first()
  }

  private serialize(row: Integration) {
    const adapter = providerFor(row.provider)
    const secrets = decryptSecrets(row.secrets)
    const secretHints: Record<string, string | null> = {}
    for (const f of adapter?.def.fields ?? []) if (f.secret) secretHints[f.key] = maskSecret(secrets[f.key])
    return {
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      providerName: adapter?.def.name ?? row.provider,
      label: row.label,
      status: row.status,
      config: row.config ?? {},
      secretHints,
      isDefault: row.isDefault,
      webhookUrl: adapter?.def.deliveryReports ? hookUrlFor(row) : null,
      lastTestedAt: row.lastTestedAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }
  }
}
