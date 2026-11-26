// The writer behind asset_value_day (docs/asset-valuation.md): what each
// owner's hangar was worth on each UTC day, priced at that day's Jita split.
// The arithmetic is asset_value_day_compute() in Postgres; this module only
// says which owner and which days.
//
//   character-assets → the registration, today, after each reconcile
//   corp-assets      → the corporation, today, after each reconcile
//
// Run as a CLI it backfills every owner from its first asset version (or
// `--since YYYY-MM-DD`) to today, skipping the days before the price record
// begins: `pnpm run asset-values`. Recompute, never increment, so a re-run
// only converges.
import { map, splitEvery } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'asset-values'

const DAY_MS = 86_400_000
// Days per RPC call in the backfill: each day is one walk over the owner's
// asset history, so a week stays well under the service role's timeout.
const CHUNK_DAYS = 7
const PAGE = 1000

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10)

// Every UTC day from `from` to `to`, inclusive, as YYYY-MM-DD.
export const daysBetween = (from, to) =>
  Array.from({ length: Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1) }, (_, i) =>
    utcDay(Date.parse(from) + i * DAY_MS)
  )

const compute = async ({ registration_id = null, corporation_id = null }, from, to) => {
  const { data, error } = await sudoSupabase.rpc('asset_value_day_compute', {
    p_registration_id: registration_id,
    p_corporation_id: corporation_id,
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return Number(data ?? 0)
}

// Today's value for one owner, after its asset reconcile. Best-effort, like
// recordReassembly: the reconcile has committed, and a missing day only leaves
// a gap the chart carries over.
export const recordAssetValue = async (tag, owner) => {
  const today = utcDay(Date.now())
  try {
    await compute(owner, today, today)
  } catch (e) {
    console.error(`[${tag}] asset value for ${owner.registration_id ?? owner.corporation_id} failed:`, e?.message ?? e)
  }
}

// The first day with a Jita price on record: Tritanium's first capture, which
// every capture carries, read through the per-type index.
const priceRecordStart = async () => {
  const { data, error } = await sudoSupabase
    .from('market_price_over_time')
    .select('valid_from')
    .eq('market', 'jita')
    .eq('type_id', 34)
    .order('valid_from', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? utcDay(data.valid_from) : null
}

// An owner's first asset version, or null when it holds nothing on record.
const firstAssetDay = async (table, column, id) => {
  const { data, error } = await sudoSupabase
    .from(table)
    .select('valid_from')
    .eq(column, id)
    .order('valid_from', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? utcDay(data.valid_from) : null
}

const readAll = async (table, columns, from = 0, acc = []) => {
  const { data, error } = await sudoSupabase
    .from(table)
    .select(columns)
    .range(from, from + PAGE - 1)
  if (error) throw error
  acc.push(...(data ?? []))
  return (data ?? []).length < PAGE ? acc : readAll(table, columns, from + PAGE, acc)
}

// Every owner the backfill visits: each registration, and each corporation one
// of them is in. Owners with no asset on record are skipped by firstAssetDay.
const owners = async () => {
  const registrations = await readAll('registration', 'id, corporation_id')
  const corporations = [
    ...new Set(
      registrations
        .map((r) => r.corporation_id)
        .filter((id) => id != null)
        .map(String)
    ),
  ]
  return [
    ...map(
      (r) => ({ registration_id: r.id, table: 'character_asset_version', column: 'registration_id', id: r.id }),
      registrations
    ),
    ...map((id) => ({ corporation_id: id, table: 'corp_asset_version', column: 'corporation_id', id }), corporations),
  ]
}

export const runAssetValues = async ({ since = null } = {}) => {
  const priceStart = await priceRecordStart()
  if (!priceStart) {
    console.log(`[${TAG}] no Jita prices on record; nothing to value`)
    return
  }
  const today = utcDay(Date.now())
  const all = await owners()
  console.log(`[${TAG}] valuing ${all.length} owner(s) from ${since ?? 'their first asset'}, prices from ${priceStart}`)

  await forEachSequential(all, async (owner) => {
    const first = await firstAssetDay(owner.table, owner.column, owner.id)
    if (!first) return
    const from = [first, priceStart, since ?? first].sort().at(-1)
    const chunks = splitEvery(CHUNK_DAYS, daysBetween(from, today))
    const written = await chunks.reduce(
      (total, days) => total.then(async (n) => n + (await compute(owner, days[0], days.at(-1)))),
      Promise.resolve(0)
    )
    console.log(
      `[${TAG}] ${owner.table === 'corp_asset_version' ? 'corp ' : ''}${owner.id}: ${written} day(s) from ${from}`
    )
  })
}

const sinceArg = process.argv.indexOf('--since')
cli(import.meta.url, TAG, () => runAssetValues({ since: sinceArg >= 0 ? process.argv[sinceArg + 1] : null }))
