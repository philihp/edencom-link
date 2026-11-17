// ISK as integer cents. The journal columns are numeric(20, 2), and the chain
// rule (docs/ledger/plan.md, I-2) is an exact test: balance(n) must equal
// balance(n-1) + amount(n) to the cent. A float sum drifts, so every value is
// turned into a BigInt count of cents before any arithmetic.
//
// PostgREST serves numeric as a JSON number, psql and CSV as a string. Both
// forms are accepted. A null, an empty string or an absent value is null: the
// chain cannot use that row, and the caller must say so.
import { isNil } from 'ramda'

export type Isk = number | string | null | undefined

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/

const asText = (value: number | string): string => (typeof value === 'number' ? value.toFixed(2) : value.trim())

// '123.4' → 12340n, -0.5 → -50n, null → null. A value that is not a decimal
// with at most two places throws: it is a fault in the source, not a gap.
export const toCents = (value: Isk): bigint | null => {
  if (isNil(value) || value === '') return null
  const match = DECIMAL.exec(asText(value))
  if (!match) throw new Error(`not an ISK amount: ${String(value)}`)
  const [, sign, whole, fraction = ''] = match
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  return sign === '-' ? -cents : cents
}

const absolute = (cents: bigint): bigint => (cents < 0n ? -cents : cents)

// 12340n → '123.40'. The inverse of toCents, for reports and tests.
export const formatCents = (cents: bigint): string =>
  `${cents < 0n ? '-' : ''}${absolute(cents) / 100n}.${String(absolute(cents) % 100n).padStart(2, '0')}`
