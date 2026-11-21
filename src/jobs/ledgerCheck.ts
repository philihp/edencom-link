// ledger-check: the daily proof that each wallet journal is complete
// (ledger stage 1, docs/ledger/stage-1.md; docs/ledger/plan.md layer 0).
//
//   pnpm run ledger-check -- --dry-run            read, compute, print; write nothing
//   pnpm run ledger-check -- [--budget 3000]      write segments and checks
//
// For each wallet (a character, or one division of a corporation) it reads
// only the journal rows newer than the last stored segment, continues the
// balance chain, compares the newest balance snapshot, and writes the changed
// segments plus one ledger_check row. The pure rules are src/ledger/check.ts.
//
// Load (guard C2): reads are keyset pages of 1,000 rows on the journal's
// primary key, with a pause; a wallet is read in full only on its first run
// or when rows arrived late inside the stored span. Writes stop at the row
// budget (I-14). The job writes ONLY to ledger_wallet_segment and ledger_check
// (guard C1; .github/scripts/check-ledger-sources.mjs) and fails no extract.
import { setTimeout as sleep } from 'node:timers/promises'

import { chain as flatMap, last, map, range, uniqBy } from 'ramda'

import { type JournalRow, type Segment } from '../ledger/chain.ts'
import {
  type JournalRecord,
  type SnapshotCompare,
  compareSnapshot,
  fitsBudget,
  hiddenCreditStepsOf,
  judgeWallet,
  needsRebuild,
  nextChain,
  pickSnapshot,
  roundingStepsOf,
  segmentWrites,
  toJournalRow,
} from '../ledger/check.ts'
import { formatCents, toCents } from '../ledger/money.ts'
import { groupRegistrationIdsByCorporation, selectRegistrationIdsWithScopes, sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'ledger-check'
const CHARACTER_SCOPE = 'esi-wallet.read_character_wallet.v1'
const CORPORATION_SCOPE = 'esi-wallet.read_corporation_wallets.v1'
const PAGE = 1000
const PAUSE_MS = 200
export const DEFAULT_BUDGET = 3000

type Wallet =
  { kind: 'character'; registrationId: string } | { kind: 'corporation'; corporationId: number; division: number }

const db = sudoSupabase as any

const keyOf = (w: Wallet): string => (w.kind === 'character' ? w.registrationId : `${w.corporationId}:${w.division}`)

// The columns that name the wallet, for filters and inserts.
const ownerOf = (w: Wallet) =>
  w.kind === 'character'
    ? { registration_id: w.registrationId, corporation_id: null, division: null }
    : { registration_id: null, corporation_id: w.corporationId, division: w.division }

const journalOf = (w: Wallet) => (w.kind === 'character' ? 'character_wallet_journal' : 'corp_wallet_journal')

const whereWallet = (query: any, w: Wallet) =>
  w.kind === 'character'
    ? query.eq('registration_id', w.registrationId)
    : query.eq('corporation_id', w.corporationId).eq('division', w.division)

// A table this PR's migration makes may not exist yet when a dry run reads
// production before the merge: read it as empty.
const MISSING_TABLE = ['PGRST205', '42P01']
const rowsOrEmpty = ({ data, error }: { data: unknown; error: any }, what: string) => {
  if (error && MISSING_TABLE.includes(error.code)) return []
  if (error) throw new Error(`${what}: ${error.message}`)
  return (data ?? []) as any[]
}

const enumerateWallets = async (): Promise<Wallet[]> => {
  const characterIds = (await selectRegistrationIdsWithScopes([CHARACTER_SCOPE])) as string[]
  const { byCorp } = await groupRegistrationIdsByCorporation([CORPORATION_SCOPE])
  const stored = rowsOrEmpty(
    await db.from('ledger_wallet_segment').select('registration_id, corporation_id, division').limit(100000),
    'ledger_wallet_segment'
  )
  const wallets: Wallet[] = [
    ...map((registrationId: string) => ({ kind: 'character' as const, registrationId }), characterIds),
    ...flatMap(
      (corporationId: number) =>
        map((division: number) => ({ kind: 'corporation' as const, corporationId, division }), range(1, 8)),
      [...byCorp.keys()].map(Number)
    ),
    ...map(
      (r: any): Wallet =>
        r.registration_id
          ? { kind: 'character', registrationId: r.registration_id }
          : { kind: 'corporation', corporationId: Number(r.corporation_id), division: Number(r.division) },
      stored
    ),
  ]
  return uniqBy(keyOf, wallets)
}

const toSegment = (r: any): Segment => ({
  firstEntryId: Number(r.first_entry_id),
  lastEntryId: Number(r.last_entry_id),
  firstDate: r.first_date,
  lastDate: r.last_date,
  opening: toCents(r.opening) as bigint,
  closing: toCents(r.closing) as bigint,
  rows: Number(r.row_count),
  roundingSteps: Number(r.rounding_steps),
  hiddenCreditSteps: Number(r.hidden_credit_steps ?? 0),
  pending: map((c: string | number) => toCents(c) as bigint, r.pending_credits ?? []),
})

const fromSegment = (w: Wallet) => (s: Segment) => ({
  ...ownerOf(w),
  first_entry_id: s.firstEntryId,
  last_entry_id: s.lastEntryId,
  first_date: s.firstDate,
  last_date: s.lastDate,
  opening: formatCents(s.opening),
  closing: formatCents(s.closing),
  row_count: s.rows,
  rounding_steps: s.roundingSteps,
  hidden_credit_steps: s.hiddenCreditSteps,
  pending_credits: map(formatCents, s.pending),
  computed_at: new Date().toISOString(),
})

const storedSegments = async (w: Wallet): Promise<Segment[]> =>
  map(
    toSegment,
    rowsOrEmpty(
      await whereWallet(db.from('ledger_wallet_segment').select('*'), w).order('first_entry_id'),
      'stored segments'
    )
  )

// How many journal rows the wallet holds at or before `entryId` (an
// index-only count on the primary key).
const journalCountUpTo = async (w: Wallet, entryId: number): Promise<number> => {
  const { count, error } = await whereWallet(
    db.from(journalOf(w)).select('entry_id', { count: 'exact', head: true }),
    w
  ).lte('entry_id', entryId)
  if (error) throw new Error(`journal count: ${error.message}`)
  return count ?? 0
}

// Tail-recursive keyset paging of the journal after `afterEntryId`.
const readJournal = async (w: Wallet, afterEntryId: number | null, acc: JournalRow[] = []): Promise<JournalRow[]> => {
  const base = whereWallet(
    db.from(journalOf(w)).select('entry_id, date, amount, balance, ref_type, first_party_id, second_party_id'),
    w
  )
  const { data, error } = await (afterEntryId === null ? base : base.gt('entry_id', afterEntryId))
    .order('entry_id')
    .limit(PAGE)
  if (error) throw new Error(`journal page: ${error.message}`)
  const rows = map(toJournalRow, (data ?? []) as JournalRecord[])
  rows.forEach((row) => acc.push(row))
  if (rows.length < PAGE) return acc
  await sleep(PAUSE_MS)
  return readJournal(w, (last(rows) as JournalRow).entryId, acc)
}

// The newest balance snapshot and the journal balance at its moment.
const SNAPSHOTS = 20

const snapshotOf = async (w: Wallet): Promise<{ compare: SnapshotCompare; difference: string | null }> => {
  const snapshots = rowsOrEmpty(
    w.kind === 'character'
      ? await db
          .from('character_wallet')
          .select('balance, recorded_at')
          .eq('registration_id', w.registrationId)
          .order('recorded_at', { ascending: false })
          .limit(SNAPSHOTS)
      : await db
          .from('corp_wallet')
          .select('balance, recorded_at')
          .eq('corporation_id', w.corporationId)
          .eq('division', w.division)
          .order('recorded_at', { ascending: false })
          .limit(SNAPSHOTS),
    'balance snapshot'
  )
  if (snapshots.length === 0) return { compare: 'none', difference: null }
  const [newest] = rowsOrEmpty(
    await whereWallet(db.from(journalOf(w)).select('date, balance'), w)
      .order('entry_id', { ascending: false })
      .limit(1),
    'newest journal row'
  )
  const picked = pickSnapshot(snapshots, newest ?? null)
  if (picked === null) return { compare: 'none', difference: null }
  if (picked.atNewest) return compareSnapshot(picked.snapshot.balance, newest.balance)
  const journal = rowsOrEmpty(
    await whereWallet(db.from(journalOf(w)).select('balance'), w)
      .lte('date', picked.snapshot.recorded_at)
      .order('date', { ascending: false })
      .order('entry_id', { ascending: false })
      .limit(1),
    'journal balance'
  )
  return compareSnapshot(picked.snapshot.balance, journal[0]?.balance ?? null)
}

// The newest successful journal pull of the wallet (a role-denial skip pulled
// nothing, so it does not count).
const lastPullOf = async (w: Wallet): Promise<string | null> => {
  const base = db
    .from('heartbeat')
    .select('ended_at')
    .eq('job', w.kind === 'character' ? 'character-wallet-journal' : 'corp-wallet-journal')
    .eq('ok', true)
    .is('skipped_reason', null)
  const owned =
    w.kind === 'character' ? base.eq('registration_id', w.registrationId) : base.eq('corporation_id', w.corporationId)
  const rows = rowsOrEmpty(await owned.order('ended_at', { ascending: false }).limit(1), 'heartbeat')
  return rows[0]?.ended_at ?? null
}

const writeWallet = async (w: Wallet, upsert: Segment[], remove: number[], check: Record<string, unknown>) => {
  if (remove.length > 0) {
    const { error } = await whereWallet(db.from('ledger_wallet_segment').delete(), w).in('first_entry_id', remove)
    if (error) throw new Error(`segment delete: ${error.message}`)
  }
  if (upsert.length > 0) {
    const { error } = await db
      .from('ledger_wallet_segment')
      .upsert(map(fromSegment(w), upsert), { onConflict: 'wallet_key,first_entry_id' })
    if (error) throw new Error(`segment upsert: ${error.message}`)
  }
  const { error } = await db.from('ledger_check').insert(check)
  if (error) throw new Error(`check insert: ${error.message}`)
}

type Summary = {
  wallets: number
  checked: number
  failing: number
  rowsRead: number
  rowsWritten: number
  stoppedAtBudget: boolean
}

export const runLedgerCheck = async ({ dryRun = false, budget = DEFAULT_BUDGET } = {}): Promise<Summary> => {
  const wallets = await enumerateWallets()
  const summary: Summary = {
    wallets: wallets.length,
    checked: 0,
    failing: 0,
    rowsRead: 0,
    rowsWritten: 0,
    stoppedAtBudget: false,
  }
  const now = new Date()
  await forEachSequential(wallets, async (w: Wallet) => {
    if (summary.stoppedAtBudget) return
    const stored = await storedSegments(w)
    const lastStored = stored.length === 0 ? null : stored[stored.length - 1]
    const rebuild = lastStored !== null && needsRebuild(stored, await journalCountUpTo(w, lastStored.lastEntryId))
    const rows = await readJournal(w, rebuild || lastStored === null ? null : lastStored.lastEntryId)
    // A corporation division that has never had a row is not a wallet.
    if (stored.length === 0 && rows.length === 0) return
    const chain = nextChain(stored, rows, rebuild)
    const { upsert, remove } = segmentWrites(stored, chain)
    const snapshot = await snapshotOf(w)
    const lastPullAt = await lastPullOf(w)
    const verdict = judgeWallet({ stored, chain, rebuilt: rebuild, snapshot: snapshot.compare, lastPullAt, now })
    const newest = chain.segments[chain.segments.length - 1]
    const check = {
      ...ownerOf(w),
      checked_at: now.toISOString(),
      ok: verdict.ok,
      segments: chain.segments.length,
      new_breaks: verdict.newBreaks,
      rounding_steps: roundingStepsOf(chain.segments),
      hidden_credit_steps: hiddenCreditStepsOf(chain.segments),
      rows_read: rows.length,
      rebuilt: rebuild,
      newest_entry_id: newest?.lastEntryId ?? null,
      newest_entry_date: newest?.lastDate ?? null,
      last_pull_at: lastPullAt,
      snapshot_compare: snapshot.compare,
      snapshot_difference: snapshot.difference,
      reasons: verdict.reasons,
    }
    const planned = upsert.length + remove.length + 1
    if (!fitsBudget(summary.rowsWritten, planned, budget)) {
      summary.stoppedAtBudget = true
      console.error(
        `[${TAG}] row budget ${budget} reached: ${summary.rowsWritten} written, the next wallet needs ${planned}; stopped`
      )
      return
    }
    if (!dryRun) await writeWallet(w, upsert, remove, check)
    summary.checked += 1
    summary.failing += verdict.ok ? 0 : 1
    summary.rowsRead += rows.length
    summary.rowsWritten += planned
    // A label, not the id: the log is shared.
    console.log(
      `[${TAG}] ${w.kind} #${summary.checked}: read ${rows.length}, segments ${chain.segments.length}` +
        ` (+${upsert.length} −${remove.length}), new breaks ${verdict.newBreaks}, rounding ${check.rounding_steps}, hidden credits ${check.hidden_credit_steps},` +
        ` snapshot ${snapshot.compare}, ${verdict.ok ? 'ok' : `FAIL: ${verdict.reasons.join('; ')}`}`
    )
  })
  console.log(`[${TAG}] ${dryRun ? 'DRY RUN, nothing written: ' : ''}${JSON.stringify(summary)}`)
  if (summary.stoppedAtBudget) throw new Error(`${TAG}: stopped at the row budget of ${budget}`)
  return summary
}

const args = process.argv.slice(2)
const budgetArg = args.indexOf('--budget')

cli(import.meta.url, TAG, () =>
  runLedgerCheck({
    dryRun: args.includes('--dry-run'),
    budget: budgetArg === -1 ? DEFAULT_BUDGET : Number(args[budgetArg + 1]),
  })
)
