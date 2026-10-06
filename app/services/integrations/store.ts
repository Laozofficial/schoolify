import { randomBytes } from 'node:crypto'
import encryption from '@adonisjs/core/services/encryption'
import env from '#start/env'
import Integration from '#models/integration'
import type School from '#models/school'
import { providerFor, type Kind, type ProviderCtx } from '#services/integrations/providers'
import { extraFor, type ExtraKind } from '#services/integrations/extra_providers'

/** Secrets are kept as one encrypted JSON blob per integration. */
export function encryptSecrets(secrets: Record<string, string>): string {
  return encryption.encrypt(JSON.stringify(secrets))
}

export function decryptSecrets(blob: string | null): Record<string, string> {
  if (!blob) return {}
  const raw = encryption.decrypt<string>(blob)
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function newHookToken(): string {
  return randomBytes(24).toString('hex')
}

/** Public base the providers can reach (falls back to APP_URL). */
export function publicApiBase(): string {
  return (env.get('PUBLIC_API_URL') ?? env.get('APP_URL')).replace(/\/$/, '')
}

export function hookUrlFor(row: Integration): string {
  const path = row.kind === 'payments' ? 'payments' : 'messaging'
  return `${publicApiBase()}/api/v1/hooks/${path}/${row.hookToken}`
}

/** Definition + credential check for any connection type. */
export function anyProvider(key: string) {
  return providerFor(key) ?? extraFor(key)
}

export function providerCtx(row: Integration, school: Pick<School, 'name'>): ProviderCtx {
  return {
    config: row.config ?? {},
    secrets: decryptSecrets(row.secrets),
    hookUrl: hookUrlFor(row),
    schoolName: school.name,
  }
}

/** The connection a channel sends through: the default one, else any live one. */
export async function activeIntegration(schoolId: number, kind: Kind | ExtraKind): Promise<Integration | null> {
  const rows = await Integration.query()
    .where('school_id', schoolId)
    .where('kind', kind)
    .whereNot('status', 'disabled')
    .orderBy('is_default', 'desc')
    .orderBy('id', 'asc')
  return rows.find((r) => anyProvider(r.provider)) ?? null
}

/** Mask a stored secret for display: last 4 characters only. */
export function maskSecret(v: string | undefined): string | null {
  if (!v) return null
  return v.length <= 4 ? '****' : '****' + v.slice(-4)
}
