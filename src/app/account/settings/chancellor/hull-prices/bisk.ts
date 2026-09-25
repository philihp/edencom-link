// Hull prices are typed in billions of ISK ("42" is 42,000,000,000), the unit
// players quote a supercarrier in. Pure, so it is unit-tested
// (test/hullPrices.test.ts).

// ISK from a typed price: null for an empty field (clear the price),
// 'invalid' for anything that is not a non-negative number.
export const parseBisk = (raw: string): number | null | 'invalid' => {
  const text = raw
    .trim()
    .replace(/,/g, '')
    .replace(/\s*b(isk)?$/i, '')
  if (text === '') return null
  if (!/^\d+(\.\d+)?$/.test(text)) return 'invalid'
  return Math.round(Number(text) * 1e9)
}

// The same price, as the field shows it: 42000000000 → "42".
export const formatBisk = (isk: number): string => String(Number((isk / 1e9).toFixed(3)))
