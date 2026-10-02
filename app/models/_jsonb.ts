/**
 * Shared jsonb (de)serialisers. `pg` renders a raw JS array as a Postgres
 * array literal, which fails on jsonb columns - so stringify on write and
 * parse-if-string on read.
 */
export function jsonbPrepare(v: unknown) {
  if (v === null || v === undefined) return v
  return JSON.stringify(v)
}
export function jsonbConsume(v: unknown) {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}
