// Money shown in millions of ISK, e.g. "1,234 mISK". Non-zero amounts that
// would round down to zero millions are shown as "<1 mISK".
export const formatMisk = (raw: string | number | null) => {
  if (raw === null) return '—'
  const isk = Number(raw)
  if (isk !== 0 && Math.abs(isk) < 1_000_000) return '<1 mISK'
  const n = isk / 1_000_000
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} mISK`
}
