// The balance chain: the proof that a wallet journal is complete
// (docs/ledger/plan.md, layer 0 and invariant I-2).
//
// Each journal row carries `amount` and `balance`, the wallet balance after
// the row. So for two adjacent rows of one wallet,
//
//   balance(n) = balance(n-1) + amount(n)
//
// must hold to the cent. Where it does not, rows are missing between the two,
// and `missing` is the net ISK of those rows. A SEGMENT is a longest run of
// rows where the rule holds. In a segment the journal is complete.
//
// A wallet is one character, or one division of one corporation. The caller
// gives the rows of ONE wallet. They are ordered here by entry id, because the
// rule needs an order and entry ids are what ESI sorts by (whether entry id
// order equals time order is census question H1).
//
// A row with no amount or no balance cannot be chained. It closes the segment
// before it and belongs to no segment. It is reported as a break of kind
// `unchainable`.
//
// ROUNDING. A step that is off by exactly one cent is rounding, not a missing
// row: CCP rounds `transaction_tax` and the balance apart (measured in stage
// 0, docs/ledger/measurements.md H2; the owner decided on 2026-11-19 that it
// rounds to zero). Such a step stays in the segment and is counted in
// `roundingSteps`. The segment's closing is still the journal's balance.
import { reduce, sortBy } from 'ramda'

import { type Isk, toCents } from './money.ts'

export type JournalRow = {
  entryId: number
  date: string
  amount: Isk
  balance: Isk
}

export type Segment = {
  firstEntryId: number
  lastEntryId: number
  firstDate: string
  lastDate: string
  // The balance before the first row, and after the last row, in cents.
  opening: bigint
  closing: bigint
  rows: number
  // Steps in the segment that were off by exactly one cent.
  roundingSteps: number
}

export type Break =
  | {
      kind: 'mismatch'
      afterEntryId: number
      atEntryId: number
      // The net ISK of the rows that are not in the journal, in cents:
      // balance(n) - amount(n) - balance(n-1).
      missing: bigint
    }
  | { kind: 'unchainable'; atEntryId: number }

export type Chain = { segments: Segment[]; breaks: Break[] }

type State = Chain & { open: Segment | null }

const startAt = (row: JournalRow, amount: bigint, balance: bigint): Segment => ({
  firstEntryId: row.entryId,
  lastEntryId: row.entryId,
  firstDate: row.date,
  lastDate: row.date,
  opening: balance - amount,
  closing: balance,
  rows: 1,
  roundingSteps: 0,
})

const extend = (segment: Segment, row: JournalRow, balance: bigint, rounding: boolean): Segment => ({
  ...segment,
  lastEntryId: row.entryId,
  lastDate: row.date,
  closing: balance,
  rows: segment.rows + 1,
  roundingSteps: segment.roundingSteps + (rounding ? 1 : 0),
})

export const ROUNDING_CENTS = 1n

const isRounding = (missing: bigint): boolean => missing === ROUNDING_CENTS || missing === -ROUNDING_CENTS

// The accumulator is push-mutated (CLAUDE.md: a large array is not re-spread
// per item). The state object itself is new on each step.
const closeOpen = (state: State): Segment[] => {
  if (state.open) state.segments.push(state.open)
  return state.segments
}

const step = (state: State, row: JournalRow): State => {
  const amount = toCents(row.amount)
  const balance = toCents(row.balance)
  if (amount === null || balance === null) {
    state.breaks.push({ kind: 'unchainable', atEntryId: row.entryId })
    return { segments: closeOpen(state), breaks: state.breaks, open: null }
  }
  const { open } = state
  if (open === null) return { ...state, open: startAt(row, amount, balance) }
  const missing = balance - amount - open.closing
  if (missing === 0n || isRounding(missing)) return { ...state, open: extend(open, row, balance, missing !== 0n) }
  state.breaks.push({
    kind: 'mismatch',
    afterEntryId: open.lastEntryId,
    atEntryId: row.entryId,
    missing,
  })
  return { segments: closeOpen(state), breaks: state.breaks, open: startAt(row, amount, balance) }
}

const byEntryId = sortBy((row: JournalRow) => row.entryId)

// rows of one wallet, any order → its segments and breaks, in entry id order.
//
// `from` continues a chain stored earlier: the wallet's last segment, which
// the new rows extend or break from. Rows at or before its last entry id are
// already in it and are ignored. The result then starts with `from` (extended,
// or as it was), so the caller can store it under the same first entry id.
export const chainOf = (rows: readonly JournalRow[], from: Segment | null = null): Chain => {
  const after = from === null ? rows : rows.filter((row) => row.entryId > from.lastEntryId)
  const last = reduce(step, { segments: [], breaks: [], open: from } as State, byEntryId(after as JournalRow[]))
  return { segments: closeOpen(last), breaks: last.breaks }
}

// The share of adjacent chainable pairs where the rule holds (a rounding step
// holds): the figure gate 0 tested.
// A wallet with no pairs has nothing to disprove, so it reads as 1.
export const chainHoldShare = ({ segments, breaks }: Chain): number => {
  const holds = reduce((sum, segment: Segment) => sum + segment.rows - 1, 0, segments)
  const fails = breaks.filter((b) => b.kind === 'mismatch').length
  return holds + fails === 0 ? 1 : holds / (holds + fails)
}
