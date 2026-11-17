// The /structure/rebates window: a length (the shared 1–90 day options) and,
// optionally, the UTC day it starts on. With no start day the window trails
// back from now, like every other page; with one it is the fixed span
// [from 00:00Z, from + days 00:00Z), so `?from=2026-10-01&days=30` is
// 1 October through 30 October.
//
// Pure: no I/O.
import { timeWindowDays } from '../../timeWindow.ts'

export const DEFAULT_REBATE_DAYS = 30

const DAY_MS = 86_400_000

export type RebateWindow = {
  days: number
  // The start day as YYYY-MM-DD, or null for a window trailing from now.
  from: string | null
  since: string
  until: string
  // The last UTC day the window covers, YYYY-MM-DD.
  lastDay: string
}

// A real calendar day, written YYYY-MM-DD. 2026-02-30 is refused, not rolled.
export const parseDay = (raw: string | undefined | null): string | null => {
  if (raw == null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const t = Date.parse(`${raw}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === raw ? raw : null
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const rebateWindow = (params: { days?: string | null; from?: string | null }, now: Date): RebateWindow => {
  const days = timeWindowDays(params.days ?? undefined, DEFAULT_REBATE_DAYS)
  const from = parseDay(params.from)
  const start = from != null ? Date.parse(`${from}T00:00:00Z`) : now.getTime() - days * DAY_MS
  const end = from != null ? start + days * DAY_MS : now.getTime()
  return {
    days,
    from,
    since: new Date(start).toISOString(),
    until: new Date(end).toISOString(),
    lastDay: day(end - 1),
  }
}

// The query string for a window, so each control keeps the other's value.
export const rebateWindowHref = (path: string, w: { days: number; from: string | null }): string =>
  w.from != null ? `${path}?from=${w.from}&days=${w.days}` : `${path}?days=${w.days}`
