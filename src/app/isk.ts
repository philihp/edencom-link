// Money in thousands of ISK as a bare number, e.g. "1,234". Use when the "kISK"
// unit lives elsewhere (e.g. a column header).
export const formatKiskValue = (raw: string | number | null) => {
  if (raw === null) return '—'
  return (Number(raw) / 1_000).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

// Money shown in thousands of ISK with the unit, e.g. "1,234 kISK".
export const formatKisk = (raw: string | number | null) => {
  const value = formatKiskValue(raw)
  return value === '—' ? value : `${value} kISK`
}

// Money in raw ISK as a bare number, e.g. "1,234". Reserved for structure
// taxable events (industry job tax), which are kept in ISK rather than kISK.
export const formatIskValue = (raw: string | number | null) => {
  if (raw === null) return '—'
  return Number(raw).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

// Money shown in raw ISK with the unit, e.g. "1,234 ISK".
export const formatIsk = (raw: string | number | null) => {
  const value = formatIskValue(raw)
  return value === '—' ? value : `${value} ISK`
}

// Money shown in billions of ISK with the unit, e.g. "123.456 bISK" or
// "0.004 bISK". Capped at 3 decimal places, never more.
export const formatBisk = (raw: string | number | null) => {
  if (raw === null) return '—'
  const value = (Number(raw) / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 3 })
  return `${value} bISK`
}
