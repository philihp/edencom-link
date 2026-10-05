// Time labels for the lift chart's axis and readouts. UTC throughout: EVE
// time is UTC, and the chart is rendered on the server as well as the
// client, so a label must not depend on whichever zone the renderer sits in.
// The job list keeps the app's DateTime component (local time) like every
// other table.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

// "4 Oct", or "Oct 2026" when the window is wide enough that days blur.
export const formatTick = (t: number, monthly: boolean): string => {
  const d = new Date(t)
  return monthly ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

// "4 Oct 2026 14:00" — a moment, as the hover card and the scope line say it.
export const formatMoment = (t: number): string => {
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// "Aug 2026" — when the record begins.
export const formatMonth = (t: number): string => formatTick(t, true)

// "9 Aug – 6 Oct 2026" — the window in view.
export const formatRange = (t0: number, t1: number): string =>
  `${formatTick(t0, false)} – ${formatTick(t1, false)} ${new Date(t1).getUTCFullYear()}`
