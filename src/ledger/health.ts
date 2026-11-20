// The /ledger/health fold (ledger stage 1, docs/ledger/stage-1.md). Pure: the
// page reads the caller's segment and check rows under RLS and draws what
// this returns.
//
// Per wallet: its proven spans (the segments, oldest first), the gaps between
// them with the ISK each gap is missing, and the newest check. A gap's
// missing ISK is exact: a segment's opening is the balance before its first
// row, so next.opening − previous.closing is the net of the rows that are not
// in the journal.
import { groupBy, head, map, pipe, sortBy, toPairs, values } from 'ramda'

import { formatCents, toCents } from './money.ts'

export type SegmentRow = {
  wallet_key: string
  registration_id: string | null
  corporation_id: number | null
  division: number | null
  first_entry_id: number
  last_entry_id: number
  first_date: string
  last_date: string
  opening: number | string
  closing: number | string
  row_count: number
  rounding_steps: number
}

export type CheckRow = {
  wallet_key: string
  registration_id: string | null
  corporation_id: number | null
  division: number | null
  checked_at: string
  ok: boolean
  segments: number
  new_breaks: number
  snapshot_compare: string | null
  snapshot_difference: number | string | null
  last_pull_at: string | null
  reasons: string[]
}

export type Gap = {
  afterEntryId: number
  atEntryId: number
  from: string
  to: string
  missing: string
}

export type WalletHealth = {
  walletKey: string
  registrationId: string | null
  corporationId: number | null
  division: number | null
  segments: SegmentRow[]
  gaps: Gap[]
  rows: number
  roundingSteps: number
  latest: CheckRow | null
}

const cents = (v: number | string): bigint => toCents(v) ?? 0n

const gapsOf = (segments: readonly SegmentRow[]): Gap[] =>
  segments.slice(1).map((next, i) => {
    const prev = segments[i]
    return {
      afterEntryId: prev.last_entry_id,
      atEntryId: next.first_entry_id,
      from: prev.last_date,
      to: next.first_date,
      missing: formatCents(cents(next.opening) - cents(prev.closing)),
    }
  })

const newestFirst = sortBy((c: CheckRow) => -new Date(c.checked_at).getTime())
const byFirstEntry = sortBy((s: SegmentRow) => s.first_entry_id)

type Owner = Pick<SegmentRow, 'wallet_key' | 'registration_id' | 'corporation_id' | 'division'>

const walletOf =
  (segmentsByKey: Record<string, SegmentRow[]>, checksByKey: Record<string, CheckRow[]>) =>
  (owner: Owner): WalletHealth => {
    const segments = byFirstEntry(segmentsByKey[owner.wallet_key] ?? [])
    return {
      walletKey: owner.wallet_key,
      registrationId: owner.registration_id,
      corporationId: owner.corporation_id,
      division: owner.division,
      segments,
      gaps: gapsOf(segments),
      rows: segments.reduce((sum, s) => sum + s.row_count, 0),
      roundingSteps: segments.reduce((sum, s) => sum + s.rounding_steps, 0),
      latest: head(newestFirst(checksByKey[owner.wallet_key] ?? [])) ?? null,
    }
  }

// Failing wallets first, then by key, so the page leads with what needs a look.
const failingFirst = sortBy((w: WalletHealth) => `${w.latest?.ok === false ? 0 : 1}|${w.walletKey}`)

export const walletHealth = (segments: readonly SegmentRow[], checks: readonly CheckRow[]): WalletHealth[] => {
  const segmentsByKey = groupBy((s: SegmentRow) => s.wallet_key, segments as SegmentRow[]) as Record<
    string,
    SegmentRow[]
  >
  const checksByKey = groupBy((c: CheckRow) => c.wallet_key, checks as CheckRow[]) as Record<string, CheckRow[]>
  const owners = pipe(
    toPairs,
    map(([key, rows]: [string, Owner[]]) => ({ ...rows[0], wallet_key: key }))
  )({ ...checksByKey, ...segmentsByKey } as Record<string, Owner[]>)
  return failingFirst(map(walletOf(segmentsByKey, checksByKey), values(owners) as Owner[]))
}
