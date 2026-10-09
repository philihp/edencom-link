import {
  ascend,
  chain,
  descend,
  filter,
  forEach,
  groupBy,
  map,
  prop,
  range,
  sortWith,
  splitEvery,
  sum,
  toPairs,
} from 'ramda'

import { EsiError, publicContractItems, publicContracts, universeRegions } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'
import {
  httpDate,
  intoLanes,
  listingCapped,
  listingCheck,
  publicContractItemRow,
  publicContractRow,
  regionDue,
  shrinkVerdict,
} from './publicContractFields.js'
import { shouldStandDown } from './structureResolution.js'

const TAG = 'public-contracts'

// Regions are read four at a time. The Forge alone is ~35 pages, so it sets the
// sweep's length; the other ~110 regions are a page or two each and finish
// around it.
const REGION_LANES = 4

// Item lists, newest contracts first. One request per contract, so the first
// run's backlog (every open item exchange and auction in New Eden) drains over
// a few hours of runs rather than in one. PostgREST caps a select at 1000 rows,
// which is the per-run ceiling anyway.
const ITEM_LANES = 8
const MAX_ITEM_FETCHES = 1000
const ITEM_BUDGET_MS = 120_000

// Bounded statements rather than one giant array.
const CHUNK = 500

// ESI's error budget is shared by every job on this deployment's address. Once
// a failure reports it nearly spent, stop asking for the rest of the run.
const makeStandDown = () => {
  const state = { down: false }
  return {
    isDown: () => state.down,
    note: (e) => {
      if (e instanceof EsiError && shouldStandDown(e)) state.down = true
    },
  }
}

const loadRegionStates = async () => {
  const { data, error } = await sudoSupabase
    .from('public_contract_region')
    .select('region_id, observed_at, expires_at, open_contracts, suspect_since')
  if (error) throw new Error(`reading public_contract_region failed: ${error.message}`)
  return new Map(map((row) => [Number(row.region_id), row], data ?? []))
}

const saveRegionState = async (row) => {
  const { error } = await sudoSupabase.from('public_contract_region').upsert(row, { onConflict: 'region_id' })
  if (error) throw new Error(`writing public_contract_region ${row.region_id} failed: ${error.message}`)
}

// Every page of one region's listing, as ESI served it.
const readListing = async (regionId) => {
  const first = await publicContracts(regionId, 1)
  const declared = Math.max(1, Number.parseInt(first.pages, 10) || 1)
  const rest = []
  await forEachSequential(range(2, declared + 1), async (page) => {
    rest.push(await publicContracts(regionId, page))
  })
  const pages = map((p) => ({ rows: p.json, lastModified: p.lastModified }), [first, ...rest])
  return { pages, check: listingCheck(pages, first.pages), lastModified: first.lastModified, expires: first.expires }
}

// A listing read across a snapshot change is read once more before giving up:
// the cache regenerates every 30 minutes, so a second read nearly always lands
// inside one snapshot.
const readCompleteListing = async (regionId) => {
  const listing = await readListing(regionId)
  return listing.check.complete ? listing : readListing(regionId)
}

const insertNewContracts = async (rows) =>
  forEachSequential(splitEvery(CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase
      .from('public_contract')
      .upsert(chunk, { onConflict: 'contract_id', ignoreDuplicates: true })
    if (error) throw new Error(`inserting public contracts failed: ${error.message}`)
  })

// Read one region and reconcile it. Answers an outcome for the run summary.
const sweepRegion = async (regionId, state, now) => {
  const listing = await readCompleteListing(regionId)
  const checkedAt = new Date().toISOString()
  const expiresAt = httpDate(listing.expires)

  if (!listing.check.complete) {
    // Close nothing on a listing that may be missing contracts. Leave the
    // region due, so the next run asks again.
    await saveRegionState({ region_id: regionId, expires_at: null, checked_at: checkedAt })
    return { regionId, outcome: 'incomplete', reason: listing.check.reason }
  }

  const observedAt = httpDate(listing.lastModified) ?? new Date(now).toISOString()
  const previousObservedAt = state?.observed_at ?? null
  if (previousObservedAt != null && Date.parse(observedAt) <= Date.parse(previousObservedAt)) {
    // The snapshot already reconciled, or an older one from a lagging cache
    // node. Nothing to learn; just note when to ask again.
    await saveRegionState({ region_id: regionId, expires_at: expiresAt, checked_at: checkedAt })
    return { regionId, outcome: 'unchanged' }
  }

  const listed = chain((page) => page.rows, listing.pages)
  const verdict = shrinkVerdict({
    previousOpen: state?.open_contracts ?? 0,
    listed: listed.length,
    suspectSince: state?.suspect_since ?? null,
    now,
  })
  if (verdict === 'hold') {
    await saveRegionState({
      region_id: regionId,
      expires_at: expiresAt,
      checked_at: checkedAt,
      suspect_since: state?.suspect_since ?? new Date(now).toISOString(),
    })
    return { regionId, outcome: 'held', reason: `${state?.open_contracts} open, ${listed.length} listed` }
  }

  const { data: swept, error } = await sudoSupabase.rpc('public_contract_sweep', {
    p_region_id: regionId,
    p_contract_ids: map(prop('contract_id'), listed),
    p_observed_at: observedAt,
    p_previous_observed_at: previousObservedAt,
  })
  if (error) throw new Error(`public_contract_sweep ${regionId} failed: ${error.message}`)

  // Facts first, then each new contract's first status: the status row needs
  // the contract to exist. A run that dies between the two leaves contracts
  // with no status, which the next sweep answers as new again, and both
  // writes skip what is already there.
  const newIdList = map(Number, swept?.new_ids ?? [])
  const newIds = new Set(newIdList)
  const fresh = map(
    (c) => publicContractRow(c, regionId, observedAt),
    filter((c) => newIds.has(Number(c.contract_id)), listed)
  )
  await insertNewContracts(fresh)
  const { error: openError } = await sudoSupabase.rpc('public_contract_open', {
    p_region_id: regionId,
    p_contract_ids: newIdList,
    p_observed_at: observedAt,
  })
  if (openError) throw new Error(`public_contract_open ${regionId} failed: ${openError.message}`)

  // Recorded last: if anything above failed, the snapshot is not marked
  // reconciled, and the next run sweeps it again (the sweep is idempotent).
  await saveRegionState({
    region_id: regionId,
    observed_at: observedAt,
    expires_at: expiresAt,
    open_contracts: listed.length,
    capped: listingCapped(listing.pages),
    suspect_since: null,
    checked_at: checkedAt,
  })
  return {
    regionId,
    outcome: 'swept',
    listed: listed.length,
    inserted: fresh.length,
    closed: swept?.closed ?? 0,
    reopened: swept?.reopened ?? 0,
    capped: listingCapped(listing.pages),
  }
}

const sweepRegions = async (regionIds, states, now, standDown) => {
  // Largest regions first, so The Forge starts at once rather than last.
  const ordered = sortWith(
    [descend((id) => states.get(id)?.open_contracts ?? 0), ascend((id) => id)],
    filter((id) => regionDue(states.get(id), now), regionIds)
  )
  const outcomes = []
  await Promise.all(
    map(
      (lane) =>
        forEachSequential(lane, async (regionId) => {
          if (standDown.isDown()) {
            outcomes.push({ regionId, outcome: 'skipped' })
            return
          }
          try {
            outcomes.push(await sweepRegion(regionId, states.get(regionId), now))
          } catch (e) {
            standDown.note(e)
            console.error(`[${TAG}] region ${regionId} FAILED message=${e?.message}`)
            outcomes.push({ regionId, outcome: 'failed', reason: e?.message })
          }
        }),
      intoLanes(REGION_LANES, ordered)
    )
  )
  return outcomes
}

// All pages of one contract's items. A tolerated 204/404 on the first page
// means the contract had already gone, and so does a 200 with an empty body,
// which ESI sends in place of its documented 204; it is recorded as 204.
const readItems = async (contractId) => {
  const first = await publicContractItems(contractId, 1)
  if (first.json == null) return { contractId, status: first.status === 200 ? 204 : first.status, items: [] }
  const declared = Math.max(1, Number.parseInt(first.pages, 10) || 1)
  const rest = []
  await forEachSequential(range(2, declared + 1), async (page) => {
    const more = await publicContractItems(contractId, page)
    rest.push(...(more.json ?? []))
  })
  return { contractId, status: 200, items: [...first.json, ...rest] }
}

const syncItems = async (standDown, deadline) => {
  // Outstanding item exchanges and auctions, newest first; never a courier,
  // whose items ESI answers with a 400 (public_contract_items_owed()).
  const { data: pending, error } = await sudoSupabase.rpc('public_contract_items_owed', { p_limit: MAX_ITEM_FETCHES })
  if (error) throw new Error(`reading the item backlog failed: ${error.message}`)

  const fetched = []
  const failures = { count: 0 }
  await Promise.all(
    map(
      (lane) =>
        forEachSequential(lane, async (contractId) => {
          if (standDown.isDown() || Date.now() > deadline) return
          try {
            fetched.push(await readItems(Number(contractId)))
          } catch (e) {
            // Left pending for the next run.
            standDown.note(e)
            failures.count += 1
            console.error(`[${TAG}] contract ${contractId} items FAILED message=${e?.message}`)
          }
        }),
      intoLanes(ITEM_LANES, pending ?? [])
    )
  )

  const itemRows = chain(({ contractId, items }) => map((i) => publicContractItemRow(contractId, i), items), fetched)
  await forEachSequential(splitEvery(CHUNK, itemRows), async (chunk) => {
    const { error: itemsError } = await sudoSupabase
      .from('public_contract_item')
      .upsert(chunk, { onConflict: 'contract_id,record_id', ignoreDuplicates: true })
    if (itemsError) throw new Error(`inserting public contract items failed: ${itemsError.message}`)
  })

  // Stamped only after the items committed, one update per answer status, so a
  // failed write leaves its contracts owed rather than marked done and empty.
  const fetchedAt = new Date().toISOString()
  await forEachSequential(toPairs(groupBy((r) => String(r.status), fetched)), async ([status, rows]) => {
    await forEachSequential(
      splitEvery(
        CHUNK,
        map((r) => r.contractId, rows)
      ),
      async (ids) => {
        const { error: stampError } = await sudoSupabase
          .from('public_contract')
          .update({ items_fetched_at: fetchedAt, items_status: Number(status) })
          .in('contract_id', ids)
        if (stampError) throw new Error(`stamping public contract items failed: ${stampError.message}`)
      }
    )
  })

  return {
    pending: pending?.length ?? 0,
    itemised: filter((r) => r.status === 200, fetched).length,
    gone: filter((r) => r.status !== 200, fetched).length,
    items: itemRows.length,
    failures: failures.count,
  }
}

const tally = (outcomes, outcome) => filter((o) => o.outcome === outcome, outcomes)
const sumOf = (key, rows) => sum(map((row) => row[key] ?? 0, rows))

// GET /contracts/public/{region_id}/ for every region → public_contract (the
// facts, written once) and public_contract_status_over_time (the status, SCD-2),
// and GET /contracts/public/items/{contract_id}/ → public_contract_item for the
// newest contracts not yet itemised. A contract missing from a complete listing
// of its region gets a closed status (docs/public-contracts.md). Nothing is
// ever deleted. No tokens: whole-universe public data, so the single-step
// workflow shape.
export const runPublicContracts = async () => {
  const now = Date.now()
  const standDown = makeStandDown()
  const [regionIds, states] = await Promise.all([universeRegions(), loadRegionStates()])

  const outcomes = await sweepRegions(map(Number, regionIds ?? []), states, now, standDown)
  const swept = tally(outcomes, 'swept')
  const failed = tally(outcomes, 'failed')
  console.log(
    `[${TAG}] regions: ${swept.length} swept, ${tally(outcomes, 'unchanged').length} unchanged, ` +
      `${tally(outcomes, 'incomplete').length} incomplete, ${tally(outcomes, 'held').length} held, ` +
      `${failed.length} failed, ${tally(outcomes, 'skipped').length} skipped; ` +
      `${sumOf('listed', swept)} listed, ${sumOf('inserted', swept)} new, ` +
      `${sumOf('closed', swept)} closed, ${sumOf('reopened', swept)} reopened; ` +
      `${filter((o) => o.capped, swept).length} capped at their last page`
  )
  forEach(
    (o) => console.log(`[${TAG}] region ${o.regionId} ${o.outcome}: ${o.reason}`),
    [...tally(outcomes, 'incomplete'), ...tally(outcomes, 'held')]
  )

  const items = await syncItems(standDown, Date.now() + ITEM_BUDGET_MS)
  console.log(
    `[${TAG}] items: ${items.pending} owed, ${items.itemised} itemised (${items.items} lines), ` +
      `${items.gone} already gone, ${items.failures} failed`
  )

  // A failed region or a stand-down fails the run, so the heartbeat shows it
  // and the step retries. Regions already swept are not due again on retry.
  if (standDown.isDown()) throw new Error(`stood down: ESI error budget nearly spent`)
  if (failed.length > 0) {
    throw new Error(`${failed.length} region(s) failed: ${map((o) => o.regionId, failed).join(', ')}`)
  }
}

cli(import.meta.url, TAG, runPublicContracts)
