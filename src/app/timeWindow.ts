// The trailing-days time window the Market, Indexes, Structures and Industry
// pages all carry top-right: one option list, one parser, one dropdown
// (windowSelect.tsx). Each page keeps what differs — its default, whether the
// window lives in the URL or in state, and the bucket width a span implies —
// next to the page, so the shared part is only the part that is the same.
//
// Pure: no I/O.

export type TimeWindowOption = {
  label: string
  days: number
}

export const TIME_WINDOW_OPTIONS: readonly TimeWindowOption[] = [1, 3, 7, 14, 30, 90].map((days) => ({
  label: days === 1 ? '1 day' : `${days} days`,
  days,
}))

export const isTimeWindowDays = (n: unknown): n is number =>
  typeof n === 'number' && TIME_WINDOW_OPTIONS.some((o) => o.days === n)

// Clamp a raw value — a `?days=` param, a saved choice — to one of the
// offered options, else the page's default. Defends a server query against a
// hand-edited URL as much as it reads back a preference.
export const timeWindowDays = (raw: unknown, fallback: number): number => {
  const n = Number(raw)
  return isTimeWindowDays(n) ? n : fallback
}
