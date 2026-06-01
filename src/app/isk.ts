// Money in millions of ISK as a bare number, e.g. "1,234". Non-zero amounts that
// would round down to zero millions are shown as "<1". Use when the "mISK" unit
// lives elsewhere (e.g. a column header).
export const formatMiskValue = (raw: string | number | null) => {
  if (raw === null) return '—'
  const isk = Number(raw)
  if (isk !== 0 && Math.abs(isk) < 1_000_000) return '<1'
  const n = isk / 1_000_000
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

// Money shown in millions of ISK with the unit, e.g. "1,234 mISK".
export const formatMisk = (raw: string | number | null) => {
  const value = formatMiskValue(raw)
  return value === '—' ? value : `${value} mISK`
}
