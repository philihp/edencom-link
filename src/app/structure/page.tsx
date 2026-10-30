import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  ascend,
  chain,
  concat,
  descend,
  filter,
  forEach,
  isNil,
  map,
  reduce,
  reject,
  sort,
  sortWith,
  splitEvery,
  sum,
  uniq,
} from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { DateTime } from '../DateTime'
import { AllianceShareToggles } from './allianceShareToggle'
import { FavoriteStar } from './favoriteStar'
import { fetchAllianceShareDefaults } from './shareData'
import { formatIsk, formatKisk } from '../isk'
import { LinkSpinner } from '../linkSpinner'
import { Name, SystemName } from '../names'
import { fetchSystemNames } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import {
  fetchLatestSystemIndexes,
  fetchSystemIndexHistory,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  structureIndexActivities,
} from './industryIndex'
import { groupByTier } from './roster'
import { fetchTaxRates, formatRate } from '../settings/tax/rates'
import { formatRelativeFuture } from '../relativeTime'
import { resolveServiceIcons } from './serviceIcons'
import { StructureTabs } from './structureTabs'
import { SourceTag } from './sourceTag'
import { Sparkline } from './sparkline'
import { UrlWindowSelect } from '../windowSelect'
import { indexBucketHours, structureWindowDays } from './windows'
import { MeasureFields } from './measureFields'
import { fetchAllRows, fetchJobStructureIds, loadStructureMeasures, RPC_BATCH } from './measures'
import styles from './structures.module.css'

type Structure = {
  structure_id: number
  corporation_id: number | null
  // Null for a structure the directory has never resolved: we know a job of
  // ours ran there, and nothing else. Every render of these guards.
  type_id: number | null
  system_id: number | null
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string | null
  // True when the row came from corp_structure — i.e. a director token scans
  // it, which is what makes state/services/fuel/rigs available at all. False
  // for a structure discovered from a job location and named from the public
  // directory.
  scanned: boolean
}

// universe_name rows, and the id -> name map they turn into.
type IdName = { id: number | string; name: string }

const nameById = (rows: readonly IdName[]): Map<string, string> =>
  new Map(map((r: IdName) => [String(r.id), r.name] as [string, string], rows))

type AffiliationRow = { character_id: number | string; corporation_id: number | string }

type RigRow = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
}

// universe_structure: the public directory, everything ESI hands a visitor
// about a structure they don't have a director in.
type DirectoryRow = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
  type_id: number | string | null
  owner_corporation_id: number | string | null
  resolved_at: string | null
}

type StructuresParams = {
  searchParams: Promise<{ days?: string }>
}

const StructuresPage = async ({ searchParams }: StructuresParams) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // The time window: the footer (per-structure Revenue, unaccounted tax, clone
  // revenue) sums only entries newer than this, and the industry-index
  // sparklines cover the same span. Driven by the ?days=N dropdown (top-right),
  // clamped to an offered option.
  const { days: daysParam } = await searchParams
  const windowDays = structureWindowDays(daysParam)
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  // ── The roster ────────────────────────────────────────────────────────────
  // Two sources, unioned (src/app/structure/roster.ts). corp_structure is the
  // rich one — state, services, fuel, rigs — and needs a director in the owning
  // corporation, so it covers only what we scan. Everything else we USE reaches
  // us as a bare facility id on one of our own industry jobs, named afterwards
  // from the public `universe_structure` directory.
  const { data: structures } = await supabase
    .from('corp_structure')
    .select('structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, services, last_seen_at')
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const scannedList = map((s: Structure): Structure => ({ ...s, scanned: true }), (structures ?? []) as Structure[])
  const scannedIds = new Set(map((s: Structure) => String(s.structure_id), scannedList))

  // Our own corporations, from our own registrations (RLS-scoped to the
  // caller). A structure any of them owns is a structure we own — including one
  // owned by a corp none of the installing characters are in, and including one
  // we can't scan because no linked character is a director there.
  const { data: ownRegistrations } = await supabase.from('registration').select('id, corporation_id')
  const ownRegistrationIds = new Set(map((r: { id: string }) => r.id, ownRegistrations ?? []))
  const ownCorporationIds = new Set(
    map(
      String,
      reject(
        isNil,
        map((r: { corporation_id: number | string | null }) => r.corporation_id, ownRegistrations ?? [])
      )
    )
  )
  // Structures our jobs ran in that no director of ours scans, from the
  // rollup our own jobs are folded into (./measures.ts) — no job view is
  // drained for it. NPC stations are filtered out by the id floor, and
  // anything already in corp_structure is dropped so a structure is never
  // listed twice.
  const externalIds = reject((id: string) => scannedIds.has(id), await fetchJobStructureIds(supabase))

  // What ESI tells a visitor: a name, a system, a type and an owner. Asked in
  // batches, because a long `in` list is a URL a proxy is entitled to refuse —
  // and because a select is capped at max_rows like any other.
  const directoryBatches = externalIds.length
    ? await Promise.all(
        map(
          (batch: string[]) =>
            supabase
              .from('universe_structure')
              .select('structure_id, name, system_id, type_id, owner_corporation_id, resolved_at')
              .in('structure_id', batch.map(Number)),
          splitEvery(RPC_BATCH, externalIds)
        )
      )
    : []
  const directory = new Map<string, DirectoryRow>(
    map(
      (r: DirectoryRow) => [String(r.structure_id), r] as [string, DirectoryRow],
      chain(({ data }) => (data ?? []) as DirectoryRow[], directoryBatches)
    )
  )

  // A structure the directory has never resolved still gets a tile: we know a
  // job of ours ran there, which is worth saying, and the fields it can't fill
  // render as "—" rather than being invented. Sorted by name so the block reads
  // alphabetically, with the unnamed ones last.
  const externalList: Structure[] = sortWith(
    [ascend((s: Structure) => (s.name == null ? 1 : 0)), ascend((s: Structure) => s.name ?? String(s.structure_id))],
    map((id: string): Structure => {
      const row = directory.get(id)
      return {
        structure_id: Number(id),
        corporation_id: row?.owner_corporation_id != null ? Number(row.owner_corporation_id) : null,
        type_id: row?.type_id != null ? Number(row.type_id) : null,
        system_id: row?.system_id != null ? Number(row.system_id) : null,
        name: row?.name ?? null,
        state: null,
        fuel_expires: null,
        unanchors_at: null,
        services: null,
        last_seen_at: row?.resolved_at ?? null,
        scanned: false,
      }
    }, externalIds)
  )

  // Owner names for the structures we can't scan — the one thing a tile with no
  // services, rigs or fuel timer can still lead with. From the world-readable
  // corporation directory the character-directory job maintains.
  const externalOwnerIds = uniq(
    map(
      Number,
      reject(
        isNil,
        map((s: Structure) => s.corporation_id, externalList)
      )
    )
  ) as number[]
  const { data: externalOwners } = externalOwnerIds.length
    ? await supabase.from('corporation').select('corporation_id, name').in('corporation_id', externalOwnerIds)
    : { data: [] }
  const ownerNames = new Map<string, string>(
    chain(
      (c: { corporation_id: number | string; name: string | null }) =>
        c.name != null ? [[String(c.corporation_id), c.name] as [string, string]] : [],
      (externalOwners ?? []) as Array<{ corporation_id: number | string; name: string | null }>
    )
  )

  // Tier 1 of the page (docs/structure-universe/design.md): the caller's pinned
  // structures sort above everything else, in their own `position` order.
  const { data: favoriteRows } = await supabase
    .from('structure_favorite')
    .select('structure_id, position')
    .order('position', { ascending: true })
  const favoritePosition = new Map<string, number>(
    map(
      (r: { structure_id: number | string; position: number }) =>
        [String(r.structure_id), r.position] as [string, number],
      (favoriteRows ?? []) as Array<{ structure_id: number | string; position: number }>
    )
  )
  const isFavorite = (s: Structure) => favoritePosition.has(String(s.structure_id))

  const tiers = groupByTier(
    map(
      (s: Structure) => ({
        structureId: String(s.structure_id),
        ownerCorporationId: s.corporation_id != null ? String(s.corporation_id) : null,
        scanned: s.scanned,
        structure: s,
      }),
      concat(scannedList, externalList)
    ),
    { favoritePosition, ownCorporationIds }
  )
  const blocks = [
    { key: 'favorites' as const, heading: 'favorites', structures: map((t) => t.structure, tiers.favorites) },
    { key: 'ours' as const, heading: 'our structures', structures: map((t) => t.structure, tiers.ours) },
    {
      key: 'others' as const,
      heading: "everyone else's structures",
      structures: map((t) => t.structure, tiers.others),
    },
  ]
  // Everything downstream — tax attribution, rigs, indexes, names — works off
  // one flat list; the blocks above only decide where each tile renders.
  const list = chain((block) => block.structures, blocks)

  // The two rates behind the cost-avoidance figures live on /settings/tax.
  const taxRates = await fetchTaxRates(supabase, user.id)

  // The Directors-only "share all structures with <alliance>" toggles, one per
  // directed corporation in an alliance (docs/sharing-layer/12-structure-share.md):
  // the seeded default, visible and revocable.
  const allianceShareDefaults = await fetchAllianceShareDefaults(supabase)

  // Fuel timers live in corp_structure_status now (own-corp only). RLS returns a
  // row only for structures the caller's corp owns, so an alliance-mate's
  // structure that's visible via corp_structure simply has no fuel here.
  // Scanned ids only: both tables are own-corp data that exists precisely
  // because a director pulled it, so asking about a structure we don't scan can
  // only ever come back empty — and would pad the URL with every id discovered
  // from a job.
  const scannedStructureIds = map((s: Structure) => Number(s.structure_id), scannedList)
  const { data: statusRows } = scannedStructureIds.length
    ? await supabase
        .from('corp_structure_status')
        .select('structure_id, fuel_expires')
        .in('structure_id', scannedStructureIds)
    : { data: [] }
  const fuelByStructure = new Map<string, string | null>(
    ((statusRows ?? []) as Array<{ structure_id: number | string; fuel_expires: string | null }>).map((r) => [
      String(r.structure_id),
      r.fuel_expires,
    ])
  )
  forEach((st: Structure) => {
    st.fuel_expires = fuelByStructure.get(String(st.structure_id)) ?? null
  }, list)

  // Rigs fitted to each structure (pulled from corp assets by the corp-assets job).
  const { data: rigRows } = scannedStructureIds.length
    ? await supabase
        .from('corp_structure_rig')
        .select('structure_id, location_flag, type_id')
        .in('structure_id', scannedStructureIds)
        .order('location_flag', { ascending: true })
    : { data: [] }

  const rigList = (rigRows ?? []) as RigRow[]
  const rigTypeNames = await fetchTypeNames(map((r: RigRow) => Number(r.type_id), rigList))
  // Push-mutated per structure rather than re-spread per rig: the order the
  // select asked for is the order they render in.
  const rigsByStructure = reduce(
    (acc: Map<string, Array<{ typeID: number; name: string }>>, r: RigRow) => {
      const key = String(r.structure_id)
      const rig = { typeID: Number(r.type_id), name: rigTypeNames[Number(r.type_id)] ?? String(r.type_id) }
      const existing = acc.get(key)
      if (existing) existing.push(rig)
      else acc.set(key, [rig])
      return acc
    },
    new Map<string, Array<{ typeID: number; name: string }>>(),
    rigList
  )

  // Icons for the Services chips: ESI names services rather than modules, so
  // each known name resolves to its providing Standup module's type id through
  // the SDE (./serviceIcons.ts); an unknown name keeps a bare chip.
  const serviceIcons = await resolveServiceIcons(
    uniq(chain((st: Structure) => map((svc) => svc.name, st.services ?? []), list))
  )

  // Anchor for the relative fuel countdowns. Computed once in the server
  // render so every tile agrees and hydration has fixed text to adopt.
  const now = new Date()

  // A structure the directory hasn't resolved has no system and no type, and
  // `Number(null)` is 0 — a perfectly finite id every one of these resolvers
  // would dutifully go looking for. Drop the nulls instead.
  const ids = (pick: (s: Structure) => number | null) => uniq(map(Number, reject(isNil, map(pick, list)))) as number[]

  const systemNames = await fetchSystemNames(ids((s) => s.system_id))
  const structureTypeNames = await fetchTypeNames(ids((s) => s.type_id))

  // Latest industry cost indices for the systems we hold structures in. We only
  // show, per structure, the activities its fitted service modules enable.
  const indexesBySystem = await fetchLatestSystemIndexes(
    supabase,
    ids((s) => s.system_id)
  )
  // The same window that drives the revenue footer also scopes the index
  // sparklines. indexBucketHours widens the bucket for longer windows so the
  // point count stays sane on a 100px sparkline, and names one of the widths
  // the bucketed view materializes.
  const indexHistoryBySystem = await fetchSystemIndexHistory(
    supabase,
    ids((s) => s.system_id),
    { days: windowDays, bucketHours: indexBucketHours(windowDays) }
  )

  // The tiles' figures, the same sum of rollup days /structure/[structureId]
  // runs for one structure (./measures.ts).
  const measures = await loadStructureMeasures(supabase, {
    list,
    ownRegistrationIds,
    ownCorporationIds,
    windowStart,
    taxRates,
  })
  const { ledger, avoidance, eiv, eivSkipped, installersByStructure } = measures
  const taxesPaidTotal = sum([...ledger.taxesPaidByStructure.values()])
  const unaccounted = ledger.unaccounted
  const unaccountedByParty = ledger.unaccountedByParty

  // Tax that left for a landlord with no tile here, by landlord (the rollup
  // carries the recipient on every row, so the total is known even where the
  // job never resolved), with the systems of the structures it could place
  // the charges at — from the universe_structure cache the universe-structures
  // job maintains. A structure the cache has never resolved simply contributes
  // no system rather than blocking the ISK figure.
  const unlistedStructureIds = uniq(chain((row) => [...row.structureIds], [...ledger.unlistedLandlords.values()]))
  const unlistedSystemByStructure = new Map<string, string>()
  if (unlistedStructureIds.length > 0) {
    const { data: known } = await supabase
      .from('universe_structure')
      .select('structure_id, system_id')
      .in('structure_id', unlistedStructureIds.map(Number))
    forEach(
      (r: { structure_id: number | string; system_id: number | string | null }) => {
        if (r.system_id != null) unlistedSystemByStructure.set(String(r.structure_id), String(r.system_id))
      },
      (known ?? []) as Array<{ structure_id: number | string; system_id: number | string | null }>
    )
  }

  // One row per landlord: what they took, and where. Largest first.
  const unlistedLandlords = sortWith(
    [descend(([, row]: [string, { amount: number }]) => row.amount)],
    map(
      ([corporationId, row]): [string, { amount: number; systemIds: Set<string> }] => [
        corporationId,
        {
          amount: row.amount,
          systemIds: new Set(
            chain(
              (structureId: string) => {
                const systemId = unlistedSystemByStructure.get(structureId)
                return systemId != null ? [systemId] : []
              },
              [...row.structureIds]
            )
          ),
        },
      ],
      [...ledger.unlistedLandlords.entries()]
    )
  )
  const unlistedTotal = sum(map(([, row]) => row.amount, unlistedLandlords))

  // Landlord names from the world-readable corporation directory, and system
  // names alongside the ones the tiles already resolve.
  const landlordNames = new Map<string, string>()
  const landlordIds = unlistedLandlords.map(([id]) => id).filter((id) => id !== 'unknown')
  if (landlordIds.length > 0) {
    const { data: corps } = await supabase
      .from('corporation')
      .select('corporation_id, name')
      .in('corporation_id', landlordIds.map(Number))
    forEach(
      (c: { corporation_id: number | string; name: string | null }) => {
        if (c.name != null) landlordNames.set(String(c.corporation_id), c.name)
      },
      (corps ?? []) as Array<{ corporation_id: number | string; name: string | null }>
    )
  }
  const unlistedSystemNames = await fetchSystemNames(
    uniq(unlistedLandlords.flatMap(([, row]) => [...row.systemIds])).map(Number)
  )

  // Largest payers first.
  const unaccountedParties = sortWith([descend(([, isk]: [string, number]) => isk)], [...unaccountedByParty.entries()])

  // Resolve each payer (a character) to their name and the corp they fly for. Names come from the
  // universe_name table (populated by the universe-names job) and corp affiliations from
  // character_affiliation (populated by the character-directory job); ids not yet resolved fall
  // back to showing the raw id.
  const partyIds = map(
    Number,
    reject(
      (p: string) => p === 'unknown',
      map(([party]: [string, number]) => party, unaccountedParties)
    )
  )

  const { data: charNames } = partyIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', partyIds)
    : { data: [] }
  const payerNames = nameById((charNames ?? []) as IdName[])

  const { data: affiliations } = partyIds.length
    ? await supabase.from('character_affiliation').select('character_id, corporation_id').in('character_id', partyIds)
    : { data: [] }
  const affiliationRows = (affiliations ?? []) as AffiliationRow[]
  const corpByParty = map(
    (a: AffiliationRow) => [String(a.character_id), String(a.corporation_id)] as [string, string],
    affiliationRows
  )
  const corpIds = uniq(map((a: AffiliationRow) => Number(a.corporation_id), affiliationRows))

  const { data: corpNames } = corpIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', corpIds)
    : { data: [] }
  const corpNameById = nameById((corpNames ?? []) as IdName[])

  // A party whose corporation the directory hasn't named yet simply has no corp
  // line, rather than one reading as an id.
  const payerCorps = new Map<string, string>(
    chain(([party, corpId]: [string, string]) => {
      const name = corpNameById.get(corpId)
      return name ? [[party, name] as [string, string]] : []
    }, corpByParty)
  )

  // Revenue from structure clone bays (jump clone installation and activation
  // fees), over the same window as the tax revenue above.
  const cloneJournal = await fetchAllRows<{ amount: number | string | null }>((from, to) =>
    supabase
      .from('corp_wallet_journal')
      .select('amount')
      .in('ref_type', ['jump_clone_installation_fee', 'jump_clone_activation_fee'])
      .gte('date', windowStart)
      .order('date', { ascending: false })
      .range(from, to)
  )

  const cloneRevenue = sum(map((entry: { amount: number | string | null }) => Number(entry.amount ?? 0), cloneJournal))

  // When the Structures background job last finished. Each scheduled run writes a
  // public.heartbeat row stamped with ended_at and a link to the workflow run; we
  // read back the most recent completed one.
  const { data: lastRun } = await supabase
    .from('heartbeat')
    .select('ended_at, run_url')
    .eq('job', 'corp-structures')
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // The subtitle's two counts: every tile, and the ones a corporation of ours
  // owns (favorites included — pinning moves a tile, it doesn't change whose
  // it is).
  const oursCount = filter(
    (s: Structure) => s.corporation_id != null && ownCorporationIds.has(String(s.corporation_id)),
    list
  ).length

  // The fuel countdown turns to the alert colour inside a week.
  const fuelSoon = (iso: string) => new Date(iso).getTime() - now.getTime() < 7 * 86_400_000

  const groupNotes: Record<(typeof blocks)[number]['key'], string> = {
    favorites: 'pinned — sort above everything, in your order',
    ours: 'a corporation of ours owns these — state, services, fuel and rigs where a director scans them',
    others:
      'our jobs run here, but no director of ours can scan them — only what ESI tells a visitor: no fitting, no services, no fuel timer',
  }

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>structures</h1>
          <div className={styles.subtitle}>
            <span className={styles.num}>{list.length}</span> structure{list.length === 1 ? '' : 's'} ·{' '}
            <span className={styles.num}>{oursCount}</span> ours · figures over the selected window
          </div>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.headerLinks}>
            <Link href="/structure/revenue">tax revenue events &raquo;</Link>
            <Link href="/mercenary-dens">mercenary dens &raquo;</Link>
          </span>
          <span className={styles.headerControl}>
            <span className={styles.headerControlLabel}>window</span>
            <UrlWindowSelect days={windowDays} path="/structure" />
          </span>
        </div>
      </div>
      {list.length > 0 ? (
        <>
          {blocks.map((block) =>
            block.structures.length === 0 ? null : (
              <section key={block.key}>
                <h2 className={styles.groupLabel}>
                  <span>{block.heading}</span>
                  <span className={styles.groupNote}>{groupNotes[block.key]}</span>
                  <span className={styles.groupRule} />
                </h2>
                {block.key === 'ours' && <AllianceShareToggles items={allianceShareDefaults} />}
                <ul className={styles.grid}>
                  {block.structures.map((s) => {
                    const rigs = rigsByStructure.get(String(s.structure_id)) ?? []
                    const services = s.services ?? []
                    const indexActivities = structureIndexActivities(s.services)
                    const systemIndexes = indexesBySystem.get(Number(s.system_id))
                    const systemHistory = indexHistoryBySystem.get(Number(s.system_id))
                    return (
                      <li key={`structure-${s.structure_id}`} className={styles.tile}>
                        <div className={styles.head}>
                          <div className={styles.headText}>
                            <Link href={`/structure/${s.structure_id}`} className={styles.name}>
                              {s.name ?? `Structure #${s.structure_id}`}
                              <LinkSpinner />
                            </Link>
                            {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                            <span className={styles.subId}>#{s.structure_id}</span>
                          </div>
                          <span className={styles.headTag}>
                            <SourceTag source={s.scanned ? 'live' : 'directory'} />
                          </span>
                          <FavoriteStar structureId={String(s.structure_id)} favorite={isFavorite(s)} />
                        </div>

                        <div className={styles.fields}>
                          <MeasureFields structureId={String(s.structure_id)} measures={measures} />
                          <span className={styles.label}>type</span>
                          <span className={styles.value}>
                            <Name
                              name={s.type_id != null ? structureTypeNames[Number(s.type_id)] : undefined}
                              id={s.type_id}
                            />
                          </span>
                          <span className={styles.label}>system</span>
                          <span className={styles.value}>
                            <SystemName
                              name={s.system_id != null ? systemNames[Number(s.system_id)] : undefined}
                              id={s.system_id}
                            />
                          </span>
                          {!s.scanned && (
                            <>
                              <span className={styles.label}>owner</span>
                              <span className={styles.value}>
                                <Name
                                  name={s.corporation_id != null ? ownerNames.get(String(s.corporation_id)) : undefined}
                                  id={s.corporation_id}
                                />
                              </span>
                            </>
                          )}
                          {s.fuel_expires && (
                            <>
                              <span className={styles.label}>fuel expires</span>
                              <span className={styles.value}>
                                <span className={styles.num}>
                                  <DateTime value={s.fuel_expires} />
                                </span>
                                {(() => {
                                  const relative = formatRelativeFuture(s.fuel_expires, now)
                                  return relative ? (
                                    <span className={styles.subLine} data-soon={fuelSoon(s.fuel_expires) || undefined}>
                                      {relative}
                                    </span>
                                  ) : null
                                })()}
                              </span>
                            </>
                          )}
                        </div>

                        {!s.scanned && s.name == null && (
                          <div className={styles.tileNote}>
                            never resolved by the directory — a job of ours ran here, and that is all that is known.
                          </div>
                        )}

                        <StructureTabs
                          services={services.map((svc) => ({
                            name: svc.name,
                            state: svc.state,
                            typeID: serviceIcons.get(svc.name) ?? null,
                          }))}
                          rigs={rigs.map((rig) => ({ name: rig.name, typeID: rig.typeID }))}
                          characters={installersByStructure.get(String(s.structure_id)) ?? []}
                        />

                        {indexActivities.length > 0 && (
                          <div className={styles.section}>
                            <span className={styles.sectionLabel}>industry indexes</span>
                            <ul className={styles.indexes}>
                              {indexActivities.map((activity) => {
                                const cost = systemIndexes?.get(activity)
                                const series = systemHistory?.get(activity)
                                const values = series?.values ?? []
                                return (
                                  <li key={`idx-${s.structure_id}-${activity}`} className={styles.indexRow}>
                                    <span className={styles.indexLabel}>{INDEX_ACTIVITY_LABELS[activity]}</span>
                                    <Sparkline
                                      values={values}
                                      liveCount={series?.liveCount}
                                      updatedAt={series?.updatedAt}
                                      label={INDEX_ACTIVITY_LABELS[activity]}
                                    />
                                    <span className={styles.indexValue}>{cost != null ? formatIndex(cost) : '—'}</span>
                                  </li>
                                )
                              })}
                            </ul>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          )}

          <h2 className={styles.groupLabel}>
            <span>over the window</span>
            <span className={styles.groupNote}>
              {windowDays} day{windowDays === 1 ? '' : 's'} — the same span the tiles and sparklines use
            </span>
            <span className={styles.groupRule} />
          </h2>
          <div className={styles.summaryGrid}>
            <section className={styles.panel} aria-label="Totals">
              <div className={styles.panelHead}>
                <h2>totals</h2>
                <span className={styles.spacer} />
                <SourceTag source="ledger" />
              </div>
              {unaccountedParties.length > 0 && (
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>unaccounted tax revenue</span>
                  <span className={styles.panelValue}>{formatIsk(unaccounted)}</span>
                </div>
              )}
              {taxesPaidTotal > 0 && (
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>taxes paid</span>
                  <span className={styles.panelValue}>{formatIsk(taxesPaidTotal)}</span>
                </div>
              )}
              {unlistedTotal > 0 && (
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>taxes paid elsewhere</span>
                  <span className={styles.panelValue}>{formatIsk(unlistedTotal)}</span>
                </div>
              )}
              {eiv.totalRecoveredTax > 0 && (
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>
                    taxes paid (est.) <SourceTag source="estimate" />
                  </span>
                  <span className={styles.panelValue}>{formatIsk(eiv.totalRecoveredTax)}</span>
                </div>
              )}
              {eiv.totalEiv > 0 && (
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>
                    your total EIV <SourceTag source="estimate" />
                  </span>
                  <span className={styles.panelValue}>{formatIsk(eiv.totalEiv)}</span>
                </div>
              )}
              <div className={styles.panelRow}>
                <span className={styles.panelLabel}>clone revenue</span>
                <span className={styles.panelValue}>{formatKisk(cloneRevenue)}</span>
              </div>
              <div className={`${styles.panelRow} ${styles.panelTotal}`}>
                <span className={styles.panelLabel}>cost avoidance</span>
                <span className={styles.panelValue}>{avoidance.total == null ? '—' : formatIsk(avoidance.total)}</span>
              </div>
            </section>

            <section className={styles.panel} aria-label="How to read these">
              <div className={styles.panelHead}>
                <h2>how to read these</h2>
              </div>
              <div className={styles.panelNote}>
                <p>
                  {avoidance.total == null ? (
                    <>
                      Cost avoidance needs a non-zero rate for your own characters — nothing was billed, so there is no
                      receipt to price a public structure against.{' '}
                    </>
                  ) : (
                    <>
                      Cost avoidance is facility tax never incurred: {ledger.ownReceiptJobs.toLocaleString()} job
                      {ledger.ownReceiptJobs === 1 ? '' : 's'} of ours ran in our own structures and paid us{' '}
                      {formatIsk(avoidance.billed)} at {formatRate(taxRates.own)}, where a public{' '}
                      {formatRate(taxRates.public)} would have cost {formatIsk(avoidance.counterfactual ?? 0)} and kept
                      it. No ISK changed hands, so it is not revenue.{' '}
                    </>
                  )}
                  <Link href="/settings/tax">change the rates &raquo;</Link>
                </p>
                {taxesPaidTotal > 0 && (
                  <p>
                    Taxes paid is facility tax we were actually charged, for jobs run in the structures listed above —
                    including the {formatRate(taxRates.own)} our own structures bill us. Tax paid to a corporation with
                    no structure here is counted separately, since it has no tile to belong to. Neither figure can see
                    what a character paid to a corporation that isn&rsquo;t ours: that leaves a wallet we have no
                    journal for.
                  </p>
                )}
                {eiv.totalEiv > 0 && (
                  <p>
                    Your total EIV is the Estimated Item Value of the manufacturing and reaction jobs your own
                    characters installed at these structures over the window &mdash; each job&rsquo;s ME0 material bill
                    priced at CCP&rsquo;s adjusted prices, the base the game levies every install fee against. Estimated
                    taxes recover the facility tax at structures we don&rsquo;t own, where the charge leaves a wallet no
                    journal of ours covers: a job&rsquo;s billed cost minus its system-index fee (at the index when it
                    was installed) and the 4% SCC surcharge leaves the owner&rsquo;s cut, and dividing by EIV gives
                    their rate. The estimate assumes Omega installers and current adjusted prices
                    {eivSkipped > 0 && (
                      <>
                        ; {eivSkipped.toLocaleString()} job{eivSkipped === 1 ? '' : 's'} could not be priced (missing
                        bill, price, or index history) and count{eivSkipped === 1 ? 's' : ''} toward nothing
                      </>
                    )}
                    .
                  </p>
                )}
                {unaccountedParties.length > 0 && (
                  <p>
                    Unaccounted revenue comes from industry jobs started by players we can&rsquo;t see, so we
                    can&rsquo;t tie the tax back to one of our structures.
                  </p>
                )}
              </div>
              {(unlistedLandlords.length > 0 || unaccountedParties.length > 0) && (
                <div className={styles.breakdowns}>
                  {unlistedLandlords.length > 0 && (
                    <details className={styles.breakdown}>
                      <summary>taxes paid elsewhere, by corporation ({unlistedLandlords.length})</summary>
                      <div className={styles.breakdownGrid}>
                        {unlistedLandlords.map(([corporationId, row]) => {
                          const name =
                            corporationId === 'unknown'
                              ? 'Unknown corporation'
                              : (landlordNames.get(corporationId) ?? `#${corporationId}`)
                          // Systems we could place the jobs in. A structure the cache
                          // has never resolved contributes none, so the ISK still shows
                          // with no system rather than being hidden.
                          const systems = sort(
                            (a: string, b: string) => a.localeCompare(b),
                            map((id: string) => unlistedSystemNames[Number(id)] ?? `#${id}`, [...row.systemIds])
                          )
                          return (
                            <span key={`landlord-${corporationId}`} className={styles.breakdownRow}>
                              <span>{name}</span>
                              <span className={styles.payerCorp}>{systems.join(', ')}</span>
                              <span className={styles.panelValue}>{formatIsk(row.amount)}</span>
                            </span>
                          )
                        })}
                      </div>
                    </details>
                  )}
                  {unaccountedParties.length > 0 && (
                    <details className={styles.breakdown}>
                      <summary>breakdown by payer ({unaccountedParties.length})</summary>
                      <div className={styles.breakdownGrid}>
                        {unaccountedParties.map(([party, amount]) => {
                          const name = party === 'unknown' ? 'Unknown' : (payerNames.get(party) ?? party)
                          const corp = party === 'unknown' ? undefined : payerCorps.get(party)
                          return (
                            <span key={`party-${party}`} className={styles.breakdownRow}>
                              <span>{name}</span>
                              <span className={styles.payerCorp}>{corp ?? ''}</span>
                              <span className={styles.panelValue}>{formatIsk(amount)}</span>
                            </span>
                          )
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </section>
          </div>
        </>
      ) : (
        <p>
          No structures visible. Re-link a director character on the{' '}
          <Link href="/account/registrations">Registrations</Link> page so the hourly job can fetch them.
        </p>
      )}
      <p className={styles.lastRun}>
        structures job last ran{' '}
        <span className={styles.num}>
          <DateTime value={lastRun?.ended_at} fallback="never" />
        </span>
        {lastRun?.run_url && (
          <>
            {' '}
            · <a href={lastRun.run_url}>run log &raquo;</a>
          </>
        )}
      </p>
    </>
  )
}
export default StructuresPage
