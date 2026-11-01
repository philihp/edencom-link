// The writer behind structure_measure_day and structure_installer_day_all
// (docs/structure-measure-rollup.md): the per-day rollup /structure and
// /structure/[structureId] read instead of refolding every job and journal
// row per request. The pure fold is src/app/structure/measureRollup.ts; this
// module reads one owner's sources (its jobs, the tax entries naming them,
// bills, prices, places, the index at each install), folds them, and replaces
// that owner's rows for the days in scope.
//
// Recompute, never increment. An (owner, day range) is rebuilt from its
// sources every time: idempotent, so a re-run or a retry can only converge,
// the backfill is the same code path over all time, and the three extracts
// that feed it need no bookkeeping beyond "which owners, which days":
//
//   character-industry-jobs → the registration, over the days its reconcile
//                             opened or aged out (rollupAfterJobs)
//   corp-industry-jobs      → the corporation, plus every registration whose
//                             character installed one of those jobs (its EIV
//                             is filed there), over the same days
//   corp-wallet-journal     → the corporation, over the days its new tax
//                             entries fall on (revenue), plus the owners of
//                             the jobs the recent entries name (their charges
//                             and the recovery they switch off)
//
// Run as a CLI it rebuilds everything: `pnpm run structure-measures`, with
// `--since YYYY-MM-DD` to bound the rebuild. Every hook is best-effort, the
// way recordStructureTenancy is: a rollup failure is logged, never fails the
// extract that already committed its rows.
import { chain, map, prop, splitEvery, uniq, uniqBy } from 'ramda'

import { INDEX_ACTIVITY, isPriceable } from '../app/structure/eiv.ts'
import { foldOwnerDays, indexProbeKey, jobLocationOf, utcDayOf } from '../app/structure/measureRollup.ts'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'structure-measures'

// PostgREST caps a select at max_rows; every unbounded read pages past it.
const PAGE = 1000
// Ids per `in` filter — well under what a proxy refuses in a URL.
const BATCH = 500

// How far back a journal entry still counts as "recent" for the job-side
// recompute: a tax entry is written when the job is installed, so an entry
// older than this names a job whose owner's rows the job extract itself has
// long since folded with it (or will, next run). Two days covers the 6h
// cadence of both extracts with slack.
const RECENT_ENTRY_MS = 2 * 24 * 60 * 60 * 1000

const JOB_COLUMNS =
  'job_id, installer_id, activity_id, blueprint_type_id, runs, cost, start_date, station_id, facility_id'
const ENTRY_COLUMNS = 'corporation_id, amount, date, context_id, first_party_id, second_party_id'

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString()

// Bound a timestamptz column to a day range (inclusive UTC dates), or leave
// it unbounded for a full rebuild.
const boundDays = (query, column, range) =>
  range ? query.gte(column, `${range.from}T00:00:00Z`).lt(column, nextDay(range.to)) : query

// Drain a select past max_rows: fetch one page, recurse while full.
const readAll = async (build, from = 0, acc = []) => {
  const { data, error } = await build(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  page.forEach((row) => acc.push(row))
  return page.length < PAGE ? acc : readAll(build, from + PAGE, acc)
}

// Ask about a list of ids in batches, flattening the answers.
const readIn = async (ids, build) =>
  chain(
    ({ data, error }) => {
      if (error) throw error
      return data ?? []
    },
    await Promise.all(map(build, splitEvery(BATCH, ids)))
  )

const readPersonalJobs = (registration_id, range) =>
  readAll((from, to) =>
    boundDays(
      sudoSupabase
        .from('character_industry_job_over_time')
        .select(`${JOB_COLUMNS}, registration_id`)
        .eq('registration_id', registration_id)
        .eq('is_current', true),
      'start_date',
      range
    )
      .order('id', { ascending: true })
      .range(from, to)
  )

// Corp-table jobs one character installed, in any corporation.
const readInstalledCorpJobs = (character_id, range) =>
  readAll((from, to) =>
    boundDays(
      sudoSupabase
        .from('corp_industry_job_over_time')
        .select(`${JOB_COLUMNS}, corporation_id`)
        .eq('installer_id', character_id)
        .eq('is_current', true),
      'start_date',
      range
    )
      .order('id', { ascending: true })
      .range(from, to)
  )

const readCorpJobs = (corporation_id, range) =>
  readAll((from, to) =>
    boundDays(
      sudoSupabase
        .from('corp_industry_job_over_time')
        .select(`${JOB_COLUMNS}, corporation_id`)
        .eq('corporation_id', corporation_id)
        .eq('is_current', true),
      'start_date',
      range
    )
      .order('id', { ascending: true })
      .range(from, to)
  )

const readWalletEntries = (corporation_id, range) =>
  readAll((from, to) =>
    boundDays(
      sudoSupabase
        .from('corp_wallet_journal')
        .select(ENTRY_COLUMNS)
        .eq('corporation_id', corporation_id)
        .eq('ref_type', 'industry_job_tax'),
      'date',
      range
    )
      .order('entry_id', { ascending: true })
      .range(from, to)
  )

// Every industry_job_tax entry naming one of the jobs, from every wallet.
const readEntriesByJob = async (jobIds) => {
  const rows = await readIn(jobIds, (batch) =>
    sudoSupabase
      .from('corp_wallet_journal')
      .select(ENTRY_COLUMNS)
      .eq('ref_type', 'industry_job_tax')
      .in('context_id', batch)
  )
  const byJob = new Map()
  rows.forEach((row) => {
    const key = String(row.context_id)
    const held = byJob.get(key)
    if (held) held.push(row)
    else byJob.set(key, [row])
  })
  return byJob
}

// Where a job ran, over both tables and any owner — for the wallet entries
// naming jobs this owner does not hold.
const readJobLocations = async (jobIds) => {
  const rows = await Promise.all(
    map(
      (table) =>
        readIn(jobIds, (batch) =>
          sudoSupabase.from(table).select('job_id, station_id, facility_id').eq('is_current', true).in('job_id', batch)
        ),
      ['character_industry_job_over_time', 'corp_industry_job_over_time']
    )
  )
  return new Map(
    map(
      (row) => [String(row.job_id), jobLocationOf(row)],
      chain((x) => x, rows)
    )
  )
}

// ME0 bills by blueprint type: manufacturing preferred over reaction, as
// src/sdeBlueprints.ts getBlueprintsByTypeIDs prefers it.
const readBills = async (blueprintTypeIds) => {
  const rows = await readIn(blueprintTypeIds, (batch) =>
    sudoSupabase
      .from('sde_blueprint_product')
      .select('blueprint_type_id, activity_id, materials')
      .in('blueprint_type_id', batch)
  )
  const bills = {}
  rows
    .sort((a, b) => a.activity_id - b.activity_id)
    .forEach((row) => {
      const id = Number(row.blueprint_type_id)
      if (bills[id] != null) return
      bills[id] = map((m) => ({ typeID: Number(m.typeID), quantity: Number(m.quantity) }), row.materials ?? [])
    })
  return bills
}

const readPrices = async (typeIds) => {
  const rows = await readIn(typeIds, (batch) =>
    sudoSupabase.from('market_adjusted_price').select('type_id, adjusted_price').in('type_id', batch)
  )
  return new Map(map((row) => [Number(row.type_id), Number(row.adjusted_price)], rows))
}

// A structure's system and hull: what a director scanned first, the public
// directory for the rest.
const readStructurePlaces = async (structureIds) => {
  const systemOf = new Map()
  const hullOf = new Map()
  const scanned = await readIn(structureIds, (batch) =>
    sudoSupabase.from('corp_structure').select('structure_id, system_id, type_id').in('structure_id', batch)
  )
  scanned.forEach((row) => {
    systemOf.set(String(row.structure_id), String(row.system_id))
    hullOf.set(String(row.structure_id), row.type_id != null ? Number(row.type_id) : null)
  })
  const rest = structureIds.filter((id) => !systemOf.has(String(id)))
  const directory = await readIn(rest, (batch) =>
    sudoSupabase.from('universe_structure').select('structure_id, system_id, type_id').in('structure_id', batch)
  )
  directory.forEach((row) => {
    if (row.system_id != null) systemOf.set(String(row.structure_id), String(row.system_id))
    hullOf.set(String(row.structure_id), row.type_id != null ? Number(row.type_id) : null)
  })
  return { systemOf, hullOf }
}

// The cost index in effect at each install, keyed by the probe key the fold
// looks up (industry_index_at echoes it).
const readIndexes = async (probes) => {
  const answers = chain(
    ({ data, error }) => {
      if (error) throw error
      return data ?? []
    },
    await Promise.all(
      map((batch) => sudoSupabase.rpc('industry_index_at', { probes: batch }), splitEvery(BATCH, probes))
    )
  )
  return new Map(chain((a) => (a.cost_index != null ? [[a.key, Number(a.cost_index)]] : []), answers))
}

const readHiddenJobIds = async (jobIds) =>
  new Set(
    map(
      (row) => String(row.job_id),
      await readIn(jobIds, (batch) => sudoSupabase.from('industry_job_hidden').select('job_id').in('job_id', batch))
    )
  )

const readRegisteredInstallerIds = async (characterIds) =>
  new Set(
    map(
      (row) => String(row.character_id),
      await readIn(characterIds, (batch) =>
        sudoSupabase.from('registration').select('character_id').in('character_id', batch)
      )
    )
  )

// Replace an owner's rows for the range: upsert what the fold produced, then
// sweep whatever older computation left behind in the same days. The two
// steps are not one transaction, so a reader between them sees the new rows
// and, briefly, a stale day that is about to go — never a gap.
const writeRows = async (owner, range, { measures, installers }, computedAt) => {
  const stamp = (rows) => map((row) => ({ ...row, computed_at: computedAt }), rows)
  await forEachSequential(splitEvery(BATCH, stamp(measures)), async (rows) => {
    const { error } = await sudoSupabase
      .from('structure_measure_day')
      .upsert(rows, { onConflict: 'structure_id,owner_key,utc_day' })
    if (error) throw error
  })
  await forEachSequential(splitEvery(BATCH, stamp(installers)), async (rows) => {
    const { error } = await sudoSupabase
      .from('structure_installer_day_all')
      .upsert(rows, { onConflict: 'structure_id,owner_key,utc_day' })
    if (error) throw error
  })
  const column = owner.kind === 'registration' ? 'registration_id' : 'corporation_id'
  await forEachSequential(['structure_measure_day', 'structure_installer_day_all'], async (table) => {
    let stale = sudoSupabase.from(table).delete().eq(column, owner.id).lt('computed_at', computedAt)
    if (range) stale = stale.gte('utc_day', range.from).lte('utc_day', range.to)
    const { error } = await stale
    if (error) throw error
  })
}

// Rebuild one owner's rows over a day range (null = all time).
export const recomputeOwner = async (owner, range = null) => {
  const computedAt = new Date().toISOString()
  const isRegistration = owner.kind === 'registration'
  const personalJobs = isRegistration ? await readPersonalJobs(owner.id, range) : []
  const corpJobs = isRegistration
    ? owner.characterId != null
      ? await readInstalledCorpJobs(owner.characterId, range)
      : []
    : await readCorpJobs(owner.id, range)
  const walletEntries = isRegistration ? [] : await readWalletEntries(owner.id, range)

  const jobs = uniqBy((j) => String(j.job_id), [...personalJobs, ...corpJobs])
  const jobIds = map((j) => String(j.job_id), jobs)
  const heldIds = new Set(jobIds)
  const entriesByJob = await readEntriesByJob(jobIds)
  const jobLocations = await readJobLocations(
    uniq(
      chain(
        (e) => (e.context_id != null && !heldIds.has(String(e.context_id)) ? [Number(e.context_id)] : []),
        walletEntries
      )
    )
  )

  const priceable = jobs.filter(isPriceable)
  const bills = await readBills(uniq(map((j) => Number(j.blueprint_type_id), priceable).filter(Number.isFinite)))
  const prices = await readPrices(uniq(chain((bill) => map(prop('typeID'), bill), Object.values(bills))))
  const { systemOf, hullOf } = await readStructurePlaces(uniq(map(jobLocationOf, jobs).filter((id) => id !== 0)))
  // The index at install, for the jobs recovery can run on: the
  // registration's priceable jobs with a cost, no journal entry, and a known
  // system.
  const probes = isRegistration
    ? uniqBy(
        prop('key'),
        chain((j) => {
          const systemId = systemOf.get(String(jobLocationOf(j)))
          const activity = INDEX_ACTIVITY[Number(j.activity_id)]
          if (systemId == null || activity == null || !(Number(j.cost) > 0) || entriesByJob.has(String(j.job_id)))
            return []
          return [
            {
              key: indexProbeKey(systemId, activity, j.start_date),
              system_id: Number(systemId),
              activity,
              as_of: j.start_date,
            },
          ]
        }, priceable)
      )
    : []
  const indexes = await readIndexes(probes)
  const hiddenJobIds = await readHiddenJobIds(jobIds)
  const registeredInstallerIds = isRegistration
    ? new Set()
    : await readRegisteredInstallerIds(
        uniq(chain((j) => (j.installer_id != null ? [Number(j.installer_id)] : []), corpJobs))
      )

  const folded = foldOwnerDays({
    owner,
    personalJobs,
    corpJobs,
    entriesByJob,
    walletEntries,
    jobLocations,
    registeredInstallerIds,
    hiddenJobIds,
    pricing: { bills, prices },
    indexes,
    systemOf,
    hullOf,
  })
  await writeRows(owner, range, folded, computedAt)
  return { measures: folded.measures.length, installers: folded.installers.length }
}

const describe = (owner) => (owner.kind === 'registration' ? `registration ${owner.id}` : `corp ${owner.id}`)

const recomputeOwners = async (tag, owners, range) =>
  forEachSequential(
    uniqBy((o) => `${o.kind}:${o.id}`, owners),
    async (owner) => {
      const t0 = Date.now()
      const { measures, installers } = await recomputeOwner(owner, range)
      console.log(
        `[${tag}] structure measures: ${describe(owner)} ${range ? `${range.from}..${range.to}` : 'all time'} → ${measures} measure rows, ${installers} installer rows in ${Date.now() - t0}ms`
      )
    }
  )

// The smallest day range covering every date given.
const rangeOf = (dates) => {
  const days = dates.filter(Boolean).map(utcDayOf).sort()
  return days.length === 0 ? null : { from: days[0], to: days[days.length - 1] }
}

const registrationOwners = async (characterIds) => {
  if (characterIds.length === 0) return []
  const rows = await readIn(characterIds, (batch) =>
    sudoSupabase.from('registration').select('id, character_id').in('character_id', batch)
  )
  return map((r) => ({ kind: 'registration', id: r.id, characterId: String(r.character_id) }), rows)
}

const registrationOwnersById = async (registrationIds) => {
  if (registrationIds.length === 0) return []
  const rows = await readIn(registrationIds, (batch) =>
    sudoSupabase.from('registration').select('id, character_id').in('id', batch)
  )
  return map(
    (r) => ({ kind: 'registration', id: r.id, characterId: r.character_id != null ? String(r.character_id) : null }),
    rows
  )
}

// After an industry-job reconcile: `changed` is every job the run opened or
// aged out (start_date, and installer_id for corp jobs). The owner's rows for
// those days are rebuilt; for a corporation, so are the rows of every
// registration whose character installed one, since that is where its EIV is
// filed.
export const rollupAfterJobs = async (tag, owner, changed) => {
  try {
    const range = rangeOf(map(prop('start_date'), changed))
    if (!range) return
    const owners =
      owner.registration_id != null
        ? await registrationOwnersById([owner.registration_id])
        : [
            { kind: 'corporation', id: String(owner.corporation_id) },
            ...(await registrationOwners(
              uniq(chain((j) => (j.installer_id != null ? [Number(j.installer_id)] : []), changed))
            )),
          ]
    await recomputeOwners(tag, owners, range)
  } catch (e) {
    console.warn(`[${tag}] structure measure rollup failed: ${e?.message ?? e}`)
  }
}

// After a wallet-journal pull: `entries` is the industry_job_tax rows it
// fetched (the 30-day window). Revenue is rebuilt over their days; the owners
// of the jobs the RECENT entries name get their rows rebuilt too, so a charge
// the job extract folded before the entry arrived is filed and its recovery
// switched off.
export const rollupAfterJournal = async (tag, corporation_id, entries) => {
  try {
    const range = rangeOf(map(prop('date'), entries))
    if (!range) return
    await recomputeOwners(tag, [{ kind: 'corporation', id: String(corporation_id) }], range)

    const cutoff = Date.now() - RECENT_ENTRY_MS
    const recentJobIds = uniq(
      chain(
        (e) => (e.context_id != null && new Date(e.date).getTime() >= cutoff ? [Number(e.context_id)] : []),
        entries
      )
    )
    if (recentJobIds.length === 0) return
    const [personal, corp] = await Promise.all([
      readIn(recentJobIds, (batch) =>
        sudoSupabase
          .from('character_industry_job_over_time')
          .select('job_id, registration_id, start_date')
          .eq('is_current', true)
          .in('job_id', batch)
      ),
      readIn(recentJobIds, (batch) =>
        sudoSupabase
          .from('corp_industry_job_over_time')
          .select('job_id, corporation_id, installer_id, start_date')
          .eq('is_current', true)
          .in('job_id', batch)
      ),
    ])
    const jobRange = rangeOf(map(prop('start_date'), [...personal, ...corp]))
    if (!jobRange) return
    const owners = [
      ...(await registrationOwnersById(uniq(map(prop('registration_id'), personal)))),
      ...map((c) => ({ kind: 'corporation', id: String(c) }), uniq(map(prop('corporation_id'), corp))),
      ...(await registrationOwners(uniq(chain((j) => (j.installer_id != null ? [Number(j.installer_id)] : []), corp)))),
    ]
    await recomputeOwners(tag, owners, jobRange)
  } catch (e) {
    console.warn(`[${tag}] structure measure rollup failed: ${e?.message ?? e}`)
  }
}

// Every owner the deployment knows: all registrations, and every corporation
// a registration sits in, a tenancy row names, or a corp extract was ever
// tried for.
const allOwners = async () => {
  const registrations = await readAll((from, to) =>
    sudoSupabase.from('registration').select('id, character_id').order('id', { ascending: true }).range(from, to)
  )
  const corpSources = await Promise.all(
    map(
      (table) =>
        readAll((from, to) =>
          sudoSupabase.from(table).select('corporation_id').not('corporation_id', 'is', null).range(from, to)
        ),
      ['registration', 'structure_tenant', 'corp_job_access', 'corp_structure']
    )
  )
  return [
    ...map(
      (r) => ({ kind: 'registration', id: r.id, characterId: r.character_id != null ? String(r.character_id) : null }),
      registrations
    ),
    ...map(
      (id) => ({ kind: 'corporation', id: String(id) }),
      uniq(
        map(
          (r) => Number(r.corporation_id),
          chain((x) => x, corpSources)
        )
      )
    ),
  ]
}

// The backfill: rebuild every owner over all time, or since a day.
export const runStructureMeasures = async ({ since = null } = {}) => {
  const range = since ? { from: since, to: utcDayOf(new Date().toISOString()) } : null
  const owners = await allOwners()
  console.log(`[${TAG}] rebuilding ${owners.length} owner(s) ${range ? `since ${range.from}` : 'over all time'}`)
  await recomputeOwners(TAG, owners, range)
}

const sinceArg = process.argv.indexOf('--since')
cli(import.meta.url, TAG, () => runStructureMeasures({ since: sinceArg >= 0 ? process.argv[sinceArg + 1] : null }))
