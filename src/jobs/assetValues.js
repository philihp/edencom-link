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
//
// `--resume <ISO time>` skips every day already computed at or after that
// time, so a run that stopped picks up where it left off. A call the API
// gateway times out on is retried as two halves, down to one day; an owner
// that still fails is reported at the end and the others go on.
import { map } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { halve, pendingRuns, utcDay } from './assetValueDays.js'
import { cli, forEachSequential } from './lib.js'

export { daysBetween, utcDay } from './assetValueDays.js'

const TAG = 'asset-values'

// Days per RPC call in the backfill: each day is one walk over the owner's
// asset history. The API gateway gives up on a call long before the service
// role's statement timeout, so a call stays short and splits when it is not.
const CHUNK_DAYS = 3
const ATTEMPTS = 3
const PAGE = 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// One run of days, split in two when the call fails, down to one day, which is
// tried ATTEMPTS times before the error stands.
const computeRun = async (owner, days, attempt = 1) => {
  try {
    return await compute(owner, days[0], days.at(-1))
  } catch (e) {
    if (days.length > 1) {
      const [a, b] = halve(days)
      return (await computeRun(owner, a)) + (await computeRun(owner, b))
    }
    if (attempt >= ATTEMPTS) throw e
    console.warn(`[${TAG}] ${days[0]} failed (${e?.message ?? e}), retrying`)
    await sleep(attempt * 5_000)
    return computeRun(owner, days, attempt + 1)
  }
}

// The days of one owner already computed at or after `since`.
const computedDays = async (owner, since, from = 0, acc = []) => {
  const { data, error } = await sudoSupabase
    .from('asset_value_day')
    .select('utc_day')
    .eq(owner.registration_id ? 'registration_id' : 'corporation_id', owner.id)
    .gte('computed_at', since)
    .order('utc_day')
    .range(from, from + PAGE - 1)
  if (error) throw error
  acc.push(...map((r) => r.utc_day, data ?? []))
  return (data ?? []).length < PAGE ? acc : computedDays(owner, since, from + PAGE, acc)
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
    .order('id')
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

export const runAssetValues = async ({ since = null, resume = null } = {}) => {
  const priceStart = await priceRecordStart()
  if (!priceStart) {
    console.log(`[${TAG}] no Jita prices on record; nothing to value`)
    return
  }
  const today = utcDay(Date.now())
  const all = await owners()
  console.log(
    `[${TAG}] valuing ${all.length} owner(s) from ${since ?? 'their first asset'}, prices from ${priceStart}` +
      (resume ? `, skipping days computed since ${resume}` : '')
  )

  const failed = []
  await forEachSequential(all, async (owner) => {
    const label = `${owner.table === 'corp_asset_version' ? 'corp ' : ''}${owner.id}`
    try {
      const first = await firstAssetDay(owner.table, owner.column, owner.id)
      if (!first) return
      const from = [first, priceStart, since ?? first].sort().at(-1)
      const done = resume ? await computedDays(owner, resume) : []
      const runs = pendingRuns(from, today, done, CHUNK_DAYS)
      const written = await runs.reduce(
        (total, days) => total.then(async (n) => n + (await computeRun(owner, days))),
        Promise.resolve(0)
      )
      console.log(
        `[${TAG}] ${label}: ${written} day(s) from ${from}${done.length ? `, ${done.length} already done` : ''}`
      )
    } catch (e) {
      failed.push(label)
      console.error(`[${TAG}] ${label} FAILED:`, e?.message ?? e)
    }
  })
  if (failed.length) {
    throw new Error(`${failed.length} owner(s) failed: ${failed.join(', ')}; run again with --resume to finish them`)
  }
}

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
cli(import.meta.url, TAG, () => runAssetValues({ since: arg('--since'), resume: arg('--resume') }))
