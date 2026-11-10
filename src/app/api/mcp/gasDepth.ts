// Pure seam for the gas_purchase_plan MCP tool: split one purchase of reaction
// gas between the raw form and the compressed form, from the depth of the
// Jita sell book (market_order_book, written by the market-depth job).
//
// A large purchase walks up the sell orders, so the price of each next unit
// rises. The cheaper form at the first order is often not the cheaper form
// for the whole quantity: at some point the other form becomes cheaper per
// usable unit, and the plan must change to it. This seam finds that point.
//
// Every sell order of both forms becomes one step, with a landed cost per
// usable unit in C-J6MT:
//
//   (price + freight per m³ × m³ per unit) ÷ yield
//
// where yield is 1 for raw gas and 0.95 for compressed gas (decompression
// gives back 95% of the units). Both books are sorted, so the cheapest set of
// units for N usable is the cheapest steps in order across both books. That
// greedy merge is exact here, because each book has a rising supply curve.
//
// No I/O in this module, so it is tested without a Supabase client
// (test/gasDepth.test.ts).
import { ascend, groupBy, last, map, pipe, prop, reduce, sortWith, sum, toPairs, toLower, trim } from 'ramda'

export type Form = 'raw' | 'compressed'

// Decompression gives back 95% of the units.
export const COMPRESSED_YIELD = 0.95

// The two SDE groups the market-depth job reads: Harvestable Cloud (every
// Fullerite, Mykoserocin and Cytoserocin) and Compressed Gas.
export const HARVESTABLE_CLOUD_GROUP_ID = 711
export const COMPRESSED_GAS_GROUP_ID = 4168

export type Order = { price: number; volume_remain: number }
export type Level = { price: number; units: number }

// The sell orders of one type, grouped by price, cheapest first.
export const toLevels: (orders: Order[]) => Level[] = pipe(
  groupBy((o: Order) => String(o.price)),
  toPairs,
  map(([price, orders]) => ({ price: Number(price), units: sum(map(prop('volume_remain'), orders ?? [])) })),
  sortWith([ascend(prop('price'))])
)

export type Book = { volumeM3: number; levels: Level[] }

type Step = { form: Form; price: number; units: number; yield: number; landed: number }

const yieldOf = (form: Form): number => (form === 'compressed' ? COMPRESSED_YIELD : 1)

// Raw before compressed at one landed cost: the same usable units for fewer
// units to buy and decompress.
const formRank = (form: Form): number => (form === 'raw' ? 0 : 1)

const stepsOf =
  (form: Form, freightPerM3: number) =>
  (book: Book): Step[] =>
    map(
      (level: Level) => ({
        form,
        price: level.price,
        units: level.units,
        yield: yieldOf(form),
        landed: (level.price + freightPerM3 * book.volumeM3) / yieldOf(form),
      }),
      book.levels
    )

// The tolerance on the float arithmetic of 0.95 per unit.
const EPSILON = 1e-9

export type Fill = { form: Form; price: number; units: number; landed: number }

type Walk = { remaining: number; fills: Fill[] }

const take = (walk: Walk, step: Step): Walk => {
  if (walk.remaining <= EPSILON) return walk
  const units = Math.min(step.units, Math.ceil(walk.remaining / step.yield - EPSILON))
  return {
    remaining: walk.remaining - units * step.yield,
    fills: [...walk.fills, { form: step.form, price: step.price, units, landed: step.landed }],
  }
}

// One leg is a run of fills in the same form, in the order they are bought.
// Two or more legs show where the plan changes from one form to the other.
export type Leg = {
  form: Form
  units: number
  isk: number
  fromPrice: number
  toPrice: number
  fromLanded: number
  toLanded: number
}

const toLegs: (fills: Fill[]) => Leg[] = reduce((legs: Leg[], fill: Fill): Leg[] => {
  const open = last(legs)
  const isk = fill.price * fill.units
  if (open && open.form === fill.form)
    return [
      ...legs.slice(0, -1),
      { ...open, units: open.units + fill.units, isk: open.isk + isk, toPrice: fill.price, toLanded: fill.landed },
    ]
  return [
    ...legs,
    {
      form: fill.form,
      units: fill.units,
      isk,
      fromPrice: fill.price,
      toPrice: fill.price,
      fromLanded: fill.landed,
      toLanded: fill.landed,
    },
  ]
}, [])

export type FormTotal = { units: number; isk: number; volumeM3: number }

export type Split = {
  wanted: number
  usable: number
  short: number
  raw: FormTotal
  compressed: FormTotal
  freightIsk: number
  landedIsk: number
  // The landed cost per usable unit of the last unit in the plan: the most it
  // is worth to pay for one more usable unit in C-J6MT (the C-J6 ceiling).
  marginalLanded: number | null
  averageLanded: number | null
  legs: Leg[]
}

const totalOf = (form: Form, book: Book, fills: Fill[]): FormTotal => {
  const mine = fills.filter((f) => f.form === form)
  const units = sum(map(prop('units'), mine))
  return { units, isk: sum(map((f) => f.price * f.units, mine)), volumeM3: units * book.volumeM3 }
}

// The cheapest way to have `wanted` usable units in C-J6MT from the two Jita
// books, with freight at `freightPerM3` ISK for each m³ hauled.
export const planSplit = (wanted: number, freightPerM3: number, raw: Book, compressed: Book): Split => {
  const steps = sortWith<Step>(
    [ascend(prop('landed')), ascend((s: Step) => formRank(s.form)), ascend(prop('price'))],
    [...stepsOf('raw', freightPerM3)(raw), ...stepsOf('compressed', freightPerM3)(compressed)]
  )
  const { remaining, fills } = reduce(take, { remaining: wanted, fills: [] }, steps)
  const rawTotal = totalOf('raw', raw, fills)
  const compressedTotal = totalOf('compressed', compressed, fills)
  const freightIsk = freightPerM3 * (rawTotal.volumeM3 + compressedTotal.volumeM3)
  const landedIsk = rawTotal.isk + compressedTotal.isk + freightIsk
  const short = Math.max(0, Math.ceil(remaining - EPSILON))
  const usable = wanted - short
  return {
    wanted,
    usable,
    short,
    raw: rawTotal,
    compressed: compressedTotal,
    freightIsk,
    landedIsk,
    marginalLanded: fills.length > 0 ? last(fills)!.landed : null,
    averageLanded: usable > 0 ? landedIsk / usable : null,
    legs: toLegs(fills),
  }
}

// ── Gas names ──────────────────────────────────────────────────────────────

export type GasType = { typeID: number; name: string; groupID: number; volume: number | null }

export type GasPair = { raw: GasType; compressed: GasType | null }

const COMPRESSED_PREFIX = 'compressed '

const key = pipe(trim, toLower)

// The base gas name of a raw or compressed name, in lower case.
const baseKey = (name: string): string => {
  const k = key(name)
  return k.startsWith(COMPRESSED_PREFIX) ? k.slice(COMPRESSED_PREFIX.length) : k
}

// Every raw gas with its compressed form ("Compressed " + the gas name).
export const pairGases = (types: GasType[]): GasPair[] => {
  const compressedByBase = new Map(
    types.filter((t) => t.groupID === COMPRESSED_GAS_GROUP_ID).map((t) => [baseKey(t.name), t] as const)
  )
  return types
    .filter((t) => t.groupID === HARVESTABLE_CLOUD_GROUP_ID)
    .map((raw) => ({ raw, compressed: compressedByBase.get(key(raw.name)) ?? null }))
}

export type GasMatch = { ok: true; pair: GasPair } | { ok: false; message: string }

// One gas by name: the raw or the compressed name, exact first, else a unique
// substring of the raw name ("C50" → Fullerite-C50, "amber myko" fails, "amber
// mykoserocin" works).
export const matchGas = (pairs: GasPair[], query: string): GasMatch => {
  const wanted = baseKey(query)
  const exact = pairs.find((p) => key(p.raw.name) === wanted)
  if (exact) return { ok: true, pair: exact }
  const partial = pairs.filter((p) => key(p.raw.name).includes(wanted))
  if (partial.length === 1) return { ok: true, pair: partial[0] }
  if (partial.length === 0)
    return { ok: false, message: `"${query}" is not a Fullerite, Mykoserocin or Cytoserocin gas.` }
  return {
    ok: false,
    message: `"${query}" matches ${partial.length} gases: ${partial.map((p) => p.raw.name).join(', ')}. Give the full name.`,
  }
}
