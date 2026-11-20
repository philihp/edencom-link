// The daily check of one wallet journal (ledger stage 1, docs/ledger/stage-1.md).
// Pure: the ledger-check job (src/jobs/ledgerCheck.ts) reads, calls these,
// and writes what they return.
//
// Per wallet, a run:
//   1. continues the chain from the last stored segment with the rows that
//      are newer than it (src/ledger/chain.ts), or rebuilds the whole chain
//      when rows arrived late inside the stored span;
//   2. compares the newest balance snapshot with the journal balance at that
//      moment (I-9; one cent is rounding, owner decision 2026-11-19);
//   3. checks that the wallet's journal was pulled in the last 7 days;
//   4. judges: a NEW break, a snapshot that differs, or a stale pull fails the
//      wallet. Breaks that were already stored do not fail it again, and the
//      first run of a wallet is a baseline: its old gaps are recorded, not
//      raised.
import { difference, filter, map, pluck, reduce } from 'ramda'

import { type Chain, type JournalRow, type Segment, chainOf } from './chain.ts'
import { type Isk, formatCents, toCents } from './money.ts'

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type StoredSegment = Segment

export type SnapshotCompare = 'equal' | 'one_cent' | 'differs' | 'none'

// The snapshot against the journal's balance at the snapshot's moment.
export const compareSnapshot = (
  snapshot: Isk,
  journal: Isk
): { compare: SnapshotCompare; difference: string | null } => {
  const s = toCents(snapshot)
  const j = toCents(journal)
  if (s === null || j === null) return { compare: 'none', difference: null }
  const diff = s - j
  if (diff === 0n) return { compare: 'equal', difference: '0.00' }
  if (diff === 1n || diff === -1n) return { compare: 'one_cent', difference: formatCents(diff) }
  return { compare: 'differs', difference: formatCents(diff) }
}

const rowsIn = reduce((sum: number, s: Segment) => sum + s.rows, 0)

// Rows arrived late inside the stored span when the journal now holds more
// rows at or before the last stored entry than the segments account for.
export const needsRebuild = (stored: readonly Segment[], journalRowsUpToLast: number | null): boolean =>
  stored.length > 0 && journalRowsUpToLast !== null && journalRowsUpToLast !== rowsIn(stored as Segment[])

const lastOf = (stored: readonly Segment[]): Segment | null =>
  stored.length === 0 ? null : stored.reduce((a, b) => (b.firstEntryId > a.firstEntryId ? b : a))

// The chain after this run. `rows` are the rows read: those newer than the
// last stored segment, or (rebuild) all of the wallet's rows.
export const nextChain = (stored: readonly Segment[], rows: readonly JournalRow[], rebuild: boolean): Chain => {
  if (rebuild || stored.length === 0) return chainOf(rows)
  const last = lastOf(stored) as Segment
  const continued = chainOf(rows, last)
  // Keep the stored segments before the last one; the continued chain
  // starts with the last one, extended or not.
  const earlier = filter((s: Segment) => s.firstEntryId !== last.firstEntryId, stored as Segment[])
  return { segments: [...earlier, ...continued.segments], breaks: continued.breaks }
}

// What to write: every segment of the new chain that is new or changed, and
// the stored segments (by first entry id) the new chain no longer has.
export const segmentWrites = (stored: readonly Segment[], chain: Chain): { upsert: Segment[]; remove: number[] } => {
  const key = (s: Segment) =>
    `${s.firstEntryId}|${s.lastEntryId}|${s.opening}|${s.closing}|${s.rows}|${s.roundingSteps}|${s.hiddenCreditSteps}|${s.pending.join(',')}`
  const storedKeys = new Set(map(key, stored as Segment[]))
  return {
    upsert: filter((s: Segment) => !storedKeys.has(key(s)), chain.segments),
    remove: difference(pluck('firstEntryId', stored as Segment[]), pluck('firstEntryId', chain.segments)),
  }
}

export type Verdict = {
  ok: boolean
  newBreaks: number
  reasons: string[]
}

export type WalletRun = {
  stored: readonly Segment[]
  chain: Chain
  rebuilt: boolean
  snapshot: SnapshotCompare
  lastPullAt: string | null
  now: Date
}

// The breaks this run found that were not stored before. On the first run of
// a wallet (nothing stored) there is no "before": the run is the baseline.
const newBreaksOf = ({ stored, chain, rebuilt }: WalletRun): number => {
  if (stored.length === 0) return 0
  if (!rebuilt) return chain.breaks.length
  return Math.max(0, chain.segments.length - stored.length)
}

export const judgeWallet = (run: WalletRun): Verdict => {
  const newBreaks = newBreaksOf(run)
  const pulledMs = run.lastPullAt === null ? null : new Date(run.lastPullAt).getTime()
  const reasons = [
    ...(newBreaks > 0 ? [`${newBreaks} new break${newBreaks === 1 ? '' : 's'} in the journal: rows are missing`] : []),
    ...(run.rebuilt ? ['rows arrived inside a span already checked; the chain was rebuilt'] : []),
    ...(run.snapshot === 'differs' ? ['the wallet balance snapshot differs from the journal balance'] : []),
    ...(pulledMs === null
      ? ['no successful journal pull on record']
      : run.now.getTime() - pulledMs > STALE_AFTER_MS
        ? [`the newest journal pull is older than 7 days (${run.lastPullAt})`]
        : []),
  ]
  // A rebuild alone is a notice, not a failure: late rows that chain are good
  // news. It fails only with a new break.
  const failing = reasons.filter((r) => !r.startsWith('rows arrived'))
  return { ok: failing.length === 0, newBreaks, reasons }
}

// The row budget (I-14): the writes a run may make. Each wallet's writes are
// planned before they are made; a wallet that would cross the budget is not
// written, and the run stops there.
export const fitsBudget = (written: number, planned: number, budget: number): boolean => written + planned <= budget

// One journal row as the chain reads it. A corporation that pays facility
// tax to itself (an `industry_job_tax` row whose two parties are the same)
// gets the tax back without a row: that is the row's hidden credit
// (src/ledger/chain.ts).
export type JournalRecord = {
  entry_id: number | string
  date: string
  amount: Isk
  balance: Isk
  ref_type?: string | null
  first_party_id?: number | string | null
  second_party_id?: number | string | null
}

const isSelfPaidTax = (r: JournalRecord): boolean =>
  r.ref_type === 'industry_job_tax' &&
  r.first_party_id !== null &&
  r.first_party_id !== undefined &&
  String(r.first_party_id) === String(r.second_party_id)

export const toJournalRow = (r: JournalRecord): JournalRow => {
  const amount = toCents(r.amount)
  return {
    entryId: Number(r.entry_id),
    date: r.date,
    amount: r.amount,
    balance: r.balance,
    ...(isSelfPaidTax(r) && amount !== null && amount < 0n ? { hiddenCredit: formatCents(-amount) } : {}),
  }
}

export const hiddenCreditStepsOf = reduce((sum: number, s: Segment) => sum + s.hiddenCreditSteps, 0)

export const roundingStepsOf = reduce((sum: number, s: Segment) => sum + s.roundingSteps, 0)
