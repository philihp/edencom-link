// Shared parsing for the `at` query param on the IMPORTDATA endpoints backed by
// SCD-2 history (/api/character/assets, /api/character/orders,
// /api/character/jobs, /api/corp/jobs): the moment to reconstruct the snapshot
// at, defaulting to now (the live snapshot).

// Pad a partial ISO date/time out to a full UTC timestamp so callers can pass
// just the precision they care about: 2026 → 2026-01-01T00:00:00Z, 2026-05 →
// 2026-05-01T00:00:00Z, 2026-05-30T18 → 2026-05-30T18:00:00Z, etc. Inputs that
// already carry fractional seconds or a timezone (e.g. a full toISOString) don't
// match the bare-prefix pattern and are returned untouched for Date to parse.
const completePartialAt = (value: string): string => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T ](\d{2}))?(?::(\d{2}))?(?::(\d{2}))?$/.exec(value)
  if (!m) return value
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = m
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
}

// Human-readable hint returned on an invalid `at`.
export const AT_PARAM_ERROR = 'Invalid `at` timestamp; use ISO 8601 (e.g. 2026-06-01T00:00:00Z)'

// Parse an optional `at` query param into an ISO timestamp. A missing/empty
// value defaults to now. Returns `{ ok: false }` on an unparseable value so the
// route can answer 400 with AT_PARAM_ERROR.
export const parseAtParam = (raw: string | null | undefined): { ok: true; iso: string } | { ok: false } => {
  const trimmed = raw?.trim()
  const at = trimmed ? new Date(completePartialAt(trimmed)) : new Date()
  if (Number.isNaN(at.getTime())) return { ok: false }
  return { ok: true, iso: at.toISOString() }
}
