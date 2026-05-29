// Money shown in millions of ISK, e.g. "1,234 mISK".
export const formatMisk = (raw: string | number | null) => {
  if (raw === null) return '—'
  const n = Number(raw) / 1_000_000
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} mISK`
}
