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
})

const extend = (segment: Segment, row: JournalRow, balance: bigint): Segment => ({
  ...segment,
  lastEntryId: row.entryId,
  lastDate: row.date,
  closing: balance,
  rows: segment.rows + 1,
})

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
  if (open.closing + amount === balance) return { ...state, open: extend(open, row, balance) }
  state.breaks.push({
    kind: 'mismatch',
    afterEntryId: open.lastEntryId,
    atEntryId: row.entryId,
    missing: balance - amount - open.closing,
  })
  return { segments: closeOpen(state), breaks: state.breaks, open: startAt(row, amount, balance) }
}

const byEntryId = sortBy((row: JournalRow) => row.entryId)

// rows of one wallet, any order → its segments and breaks, in entry id order.
export const chainOf = (rows: readonly JournalRow[]): Chain => {
  const last = reduce(step, { segments: [], breaks: [], open: null } as State, byEntryId(rows as JournalRow[]))
  return { segments: closeOpen(last), breaks: last.breaks }
}

// The share of adjacent chainable pairs where the rule holds: the figure
// gate 0 tests (stop if below 99% for a wallet pulled without a pause).
// A wallet with no pairs has nothing to disprove, so it reads as 1.
export const chainHoldShare = ({ segments, breaks }: Chain): number => {
  const holds = reduce((sum, segment: Segment) => sum + segment.rows - 1, 0, segments)
  const fails = breaks.filter((b) => b.kind === 'mismatch').length
  return holds + fails === 0 ? 1 : holds / (holds + fails)
}
