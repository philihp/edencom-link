// Item memory over MCP (docs/ship-memory.md, "MCP tools" and "Extension:
// every singleton"): recall_item hands the player's AI everything a held
// singleton knows about itself — the dossier for its kind, the voice it
// speaks in, the memory it already carries and who can read what is written
// — so the AI can write the next version in the item's own words.
// remember_item is the write: it stores the whole next version through
// item_memory_write(), the one write path, which refuses a stale based_on
// (PT409) and an item the caller does not hold (42501). It changes nothing in
// the game, calls no ESI, and keeps every version. recall_ship and
// remember_ship are the same two handlers restricted to hulls, kept so every
// client that learned the ship tools keeps working.
//
// Same rules as tools.ts: every query runs on the caller's bearer client, so
// RLS scopes the rows to the reader's own data; the loaders narrow them to
// the caller's own owners besides, since the asset views also show a
// recipient what was shared with them, and a shared item is not theirs to
// remember. The DB is the only source; nothing here calls ESI.
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import { uniq } from 'ramda'
import { z } from 'zod'

import { resolveLocations, type LocationRef } from '@/app/resolveLocations'
import { blueprintDossier, type BlueprintDossier } from '@/app/ship/memory/blueprintDossier'
import { dossier, type Dossier, type Owner, type Place } from '@/app/ship/memory/dossier'
import { inheritMemory, pendingPacksOfType } from '@/app/ship/memory/inherit'
import { loadDossierInput } from '@/app/ship/memory/load'
import { loadBlueprintInput } from '@/app/ship/memory/loadBlueprint'
import { BLUEPRINT_CATEGORY_ID, type ItemKind, kindOf, nativeVoiceOf } from '@/app/ship/memory/nativeVoice'
import { getSdeType, getSdeTypeFaction, getSdeTypeNames, getSdeTypes, searchSdeTypes, type SdeType } from '@/sdeTypes'
import { escapeLike } from '@/utils/escapeLike'
import { createBearerClient } from '@/utils/supabase/bearer'

import { dataFreshness, fetchOwnerContext, textResult, type OwnerContext, type ToolResult } from './lib'
import {
  authorOf,
  describeReader,
  type HeldOfType,
  type HullRow,
  inheritance,
  MAX_MEMORY_LENGTH,
  type MemoryVersionLike,
  parseItemId,
  pickHeldOfType,
  pickHull,
  type Reader,
  subjectOf,
  validateMemory,
  writeFailure,
} from './memoryQuery'

type SupabaseClient = ReturnType<typeof createBearerClient>
type ServerCtx = { http?: { authInfo?: AuthInfo } }

const clientFor = (ctx: ServerCtx): SupabaseClient | null =>
  ctx.http?.authInfo?.token ? createBearerClient(ctx.http.authInfo.token) : null

const userIdOf = (ctx: ServerCtx): string | null => {
  const id = ctx.http?.authInfo?.extra?.userId
  return typeof id === 'string' ? id : null
}

const JOBS = ['character-assets', 'corp-assets', 'character-status']
const BLUEPRINT_JOBS = [
  ...JOBS,
  'character-blueprints',
  'corp-blueprints',
  'character-industry-jobs',
  'corp-industry-jobs',
]

// Which items a tool answers for: every held singleton, or hulls alone (the
// ship-named aliases).
type Scope = { shipsOnly: boolean }

const noun = (scope: Scope): string => (scope.shipsOnly ? 'ship' : 'item')
const recallTool = (scope: Scope): string => (scope.shipsOnly ? 'recall_ship' : 'recall_item')

const isShip = (type: SdeType | null | undefined): boolean => type != null && kindOf(type) === 'ship'

const HULL_COLUMNS = 'item_id, name, type_id, is_current, valid_until'

// A name over the caller's own named items, current and dead. Corp rows
// carry no name (ESI names only a character's items), so a corp item is
// reached by id. The name filter runs in SQL; for the ship aliases the SDE
// category check keeps the match to hulls, since a container can be named
// too.
const itemByName = async (supabase: SupabaseClient, owners: OwnerContext, query: string, scope: Scope) => {
  if (owners.registrationIds.length === 0) return { ok: false as const, message: 'No linked characters.' }
  const { data } = await supabase
    .from('character_asset_over_time')
    .select(HULL_COLUMNS)
    .in('registration_id', owners.registrationIds)
    .ilike('name', `%${escapeLike(query.trim())}%`)
    .limit(500)
  const rows = (data ?? []) as HullRow[]
  const types = await getSdeTypes(uniq(rows.map((r) => Number(r.type_id))))
  const candidates = scope.shipsOnly ? rows.filter((r) => isShip(types[Number(r.type_id)])) : rows
  const picked = pickHull(query, candidates, noun(scope))
  return picked.ok ? { ok: true as const, itemId: Number(picked.id) } : picked
}

type HeldRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  location_id: number | string | null
}
type ResearchRow = {
  item_id: number | string
  material_efficiency: number | null
  time_efficiency: number | null
  quantity: number | string | null
}

// A type name over the caller's held singletons ("my Vexor BPO", "the Vexor
// Blueprint"): one of the type resolves; several are listed, with what
// tells them apart, for the user to pick by id. Only for the generic tools —
// a hull is always named in game, so the ship aliases stop at the name.
const itemByType = async (supabase: SupabaseClient, owners: OwnerContext, query: string) => {
  const types = await searchSdeTypes(query, 10)
  if (types.length === 0) return null
  const typeIds = types.map((t) => t.typeID)
  const nameOf = new Map(types.map((t) => [t.typeID, t.name]))
  const read = async (table: 'character_asset' | 'corp_asset', column: string, ids: string[]) => {
    if (ids.length === 0) return []
    const { data } = await supabase
      .from(table)
      .select('item_id, type_id, location_flag, location_id')
      .in('type_id', typeIds)
      .eq('is_singleton', true)
      .in(column, ids)
      .limit(50)
      .returns<HeldRow[]>()
    return (data ?? []) as HeldRow[]
  }
  const rows = [
    ...(await read('character_asset', 'registration_id', owners.registrationIds)),
    ...(await read('corp_asset', 'corporation_id', owners.corporationIds)),
  ]
  if (rows.length === 0) return null

  // A blueprint's research tells two of a type apart; read it where the type
  // is one.
  const research = new Map<number, ResearchRow>()
  const blueprintTypeIds = new Set(types.filter((t) => t.categoryID === BLUEPRINT_CATEGORY_ID).map((t) => t.typeID))
  const blueprintIds = rows.filter((r) => blueprintTypeIds.has(Number(r.type_id))).map((r) => Number(r.item_id))
  if (blueprintIds.length > 0) {
    const [{ data: own }, { data: corp }] = await Promise.all([
      supabase
        .from('character_blueprint')
        .select('item_id, material_efficiency, time_efficiency, quantity')
        .in('item_id', blueprintIds),
      supabase
        .from('corp_blueprint')
        .select('item_id, material_efficiency, time_efficiency, quantity')
        .in('item_id', blueprintIds),
    ])
    ;[...((own ?? []) as ResearchRow[]), ...((corp ?? []) as ResearchRow[])].forEach((r) =>
      research.set(Number(r.item_id), r)
    )
  }
  const held: HeldOfType[] = rows.map((r) => {
    const bp = research.get(Number(r.item_id))
    const detail =
      bp != null
        ? `${Number(bp.quantity) === -2 ? 'copy' : 'original'}, ME ${bp.material_efficiency ?? 0} TE ${bp.time_efficiency ?? 0}`
        : r.location_flag && /^(Hi|Med|Lo|Rig|SubSystem)Slot\d$/.test(r.location_flag)
          ? `${r.location_flag} of item #${r.location_id}`
          : null
    return { item_id: r.item_id, type_name: nameOf.get(Number(r.type_id)) ?? `Type #${r.type_id}`, detail }
  })
  const picked = pickHeldOfType(query, held)
  return picked.ok ? { ok: true as const, itemId: Number(picked.id) } : picked
}

// The item a tool call names: by id, by name over the caller's own named
// items, or (generic tools only) by type name over what they hold.
const resolveItem = async (supabase: SupabaseClient, owners: OwnerContext, query: string, scope: Scope) => {
  const byId = parseItemId(query)
  if (byId != null) return { ok: true as const, itemId: byId }
  const byName = await itemByName(supabase, owners, query, scope)
  if (byName.ok || scope.shipsOnly) return byName
  const byType = await itemByType(supabase, owners, query)
  return byType ?? byName
}

// The type of the item's one current asset row under the caller's owners,
// with the slot it sits in; null when the caller holds no such item now.
const heldType = async (
  supabase: SupabaseClient,
  owners: OwnerContext,
  itemId: number
): Promise<{ typeId: number; flag: string | null } | null> => {
  const read = async (table: 'character_asset_version' | 'corp_asset_version', column: string, ids: string[]) => {
    if (ids.length === 0) return null
    const { data } = await supabase
      .from(table)
      .select('type_id, location_flag')
      .eq('item_id', itemId)
      .eq('is_current', true)
      .in(column, ids)
      .maybeSingle<{ type_id: number | string; location_flag: string | null }>()
    return data == null ? null : { typeId: Number(data.type_id), flag: data.location_flag }
  }
  return (
    (await read('character_asset_version', 'registration_id', owners.registrationIds)) ??
    (await read('corp_asset_version', 'corporation_id', owners.corporationIds))
  )
}

type MemoryRow = MemoryVersionLike & { id: number | string; author: string; body: string; type_id: number | string }

type ShareRow = {
  item_id: number | string
  corporation_ids: Array<number | string>
  alliance_ids: Array<number | string>
  secret: string | null
  show_as_main?: boolean
}

// The share rows whose subject is the item, a container above it, or its
// place — on the caller's own rows (the owner-manages policy) plus any
// audience row aimed at them. A recipient's own corp share rows on a corp
// item come through the member-read policy the same way.
const readersOf = async (supabase: SupabaseClient, itemId: number): Promise<Reader[]> => {
  const { data: chain } = await supabase.rpc('asset_ancestors', { start_id: itemId })
  const rows = (chain ?? []) as Array<{ item_id: number | string; location_id: number | string | null; depth: number }>
  const containerIds = rows.filter((r) => Number(r.item_id) !== itemId).map((r) => Number(r.item_id))
  const top = rows[rows.length - 1]
  const placeId = top?.location_id == null ? null : Number(top.location_id)
  const subjects = uniq([itemId, ...containerIds, ...(placeId == null ? [] : [placeId])])
  const [{ data: character }, { data: corp }] = await Promise.all([
    supabase
      .from('character_asset_share')
      .select('item_id, corporation_ids, alliance_ids, secret, show_as_main')
      .in('item_id', subjects),
    supabase.from('corp_asset_share').select('item_id, corporation_ids, alliance_ids, secret').in('item_id', subjects),
  ])
  return [...((character ?? []) as ShareRow[]), ...((corp ?? []) as ShareRow[])].flatMap((row) => {
    const subject = subjectOf(row.item_id, itemId, containerIds, placeId)
    return subject == null ? [] : [describeReader(row, subject)]
  })
}

const hours = (h: number): number => Math.round(h * 10) / 10
const days = (h: number): number => Math.round((h / 24) * 10) / 10
const percent = (fill: number | null): number | null => (fill == null ? null : Math.round(fill * 100))

const placeRef = (p: Place): LocationRef => ({ id: String(p.id), type: p.type === 'item' ? null : p.type })

// The asset dossier with every id named: owners, places, types, pilots. The
// ship sections (pilots, cargo, fuel, fit) are drawn for a hull; a container
// keeps its contents as cargo; everything else keeps the parts any item has
// — debut, origin, owners and docks.
const describe = async (supabase: SupabaseClient, owners: OwnerContext, d: Dossier, kind: ItemKind) => {
  const placeRefs: LocationRef[] = uniq(
    [...d.itinerary.map((s) => s.place), d.debut.place].filter((p): p is Place => p != null).map(placeRef)
  )
  const [locations, typeNames] = await Promise.all([
    resolveLocations(placeRefs, supabase),
    getSdeTypeNames([
      d.typeId,
      ...d.cargo.lines.map((l) => l.typeId),
      ...d.fit.current.map((l) => l.typeId),
      ...(d.fuel?.fuelTypeId == null ? [] : [d.fuel.fuelTypeId]),
    ]),
  ])
  const nameOf = (typeId: number) => typeNames[typeId] ?? `Type #${typeId}`
  const ownerName = (o: Owner) => owners.nameById.get(o.id) ?? `${o.kind} ${o.id}`
  const placeName = (p: Place | null, parentId: number | null) =>
    p == null
      ? parentId == null
        ? null
        : `aboard item #${parentId}`
      : `${locations.nameFor(placeRef(p))}${locations.systemFor(placeRef(p)) ? ` (${locations.systemFor(placeRef(p))})` : ''}`

  const origin = d.origin
  const common = {
    lineage:
      d.lineage.length === 0
        ? null
        : {
            note: 'The item was repackaged and assembled again; its memory came through these earlier item ids, nearest first, and the history below covers them all. One item, several ids.',
            earlier_ids: d.lineage.map((l) => ({ item_id: l.itemId, carried: l.carriedAt })),
          },
    names: d.names.map((n) => ({ name: n.name, from: n.from, until: n.until })),
    debut: {
      first_seen: d.debut.at,
      owner: ownerName(d.debut.owner),
      place: placeName(d.debut.place, null),
      predates_record: d.debut.predatesRecord,
    },
    origin: {
      ...origin,
      ...('owner' in origin ? { owner: ownerName(origin.owner) } : {}),
      note:
        'note' in origin
          ? origin.note
          : 'Inferred from the same type appearing in that record just before the item debuted; no table links an item to the job, contract or buy that produced it.',
    },
    owners: d.tenures.map((t) => ({ owner: ownerName(t.owner), from: t.from, until: t.until })),
    docks: {
      note: 'Sampled every extract (6h for a character, daily for a corporation): the route between docks is invisible, and a stop between two runs is missed.',
      stops: d.itinerary.map((s) => ({
        place: placeName(s.place, s.parentId),
        arrived: s.arrived,
        departed: s.departed,
        days: days(s.hours),
      })),
      total_stops: d.itinerary.length,
      distinct_places: uniq(d.itinerary.map((s) => s.place?.id ?? `item:${s.parentId}`)).length,
    },
  }
  const contents = {
    note: 'At-least figures: each item counts once at the most of it ever seen inside, and anything loaded and unloaded between two extracts is missed.',
    volume_m3_at_least: d.cargo.volumeAtLeast,
    distinct_types: d.cargo.distinctTypes,
    lines: d.cargo.lines.slice(0, 40).map((l) => ({ item: nameOf(l.typeId), quantity: l.maxQuantity, m3: l.volume })),
  }
  if (kind === 'container') return { ...common, contents }
  if (kind !== 'ship') return common
  return {
    ...common,
    pilots: d.pilots.map((p) => ({
      pilot: owners.nameById.get(p.registrationId) ?? p.registrationId,
      boardings: p.boardings,
      first_boarded: p.first,
      last_left: p.last,
      hours_aboard_at_least: hours(p.hours),
    })),
    cargo: contents,
    fuel:
      d.fuel == null
        ? null
        : {
            fuel: d.fuel.fuelTypeId == null ? null : nameOf(d.fuel.fuelTypeId),
            bay_m3: d.fuel.capacity,
            mean_fill_percent: percent(d.fuel.meanFill),
            lowest_fill_percent: percent(d.fuel.lowestFill),
            highest_fill_percent: percent(d.fuel.highestFill),
            samples: d.fuel.samples,
            note: 'Time-weighted over the moments a fuel row existed; an empty bay writes no row, so the lowest fill is the lowest stocked fill.',
          },
    fit: {
      current: d.fit.current.map((l) => ({ slot: l.flag, module: nameOf(l.typeId), quantity: l.quantity })),
      fits_seen: d.fit.fitsSeen,
      refits_at_least: d.fit.refits,
    },
  }
}

// The blueprint dossier with every id named: products, facilities,
// installers. Every job carries the blueprint's item id, so nothing here is
// inferred; the at-least is the record's start.
const describeBlueprint = async (supabase: SupabaseClient, owners: OwnerContext, b: BlueprintDossier) => {
  const facilityRefs: LocationRef[] = b.building.facilities.map((f) => ({ id: String(f.facilityId), type: null }))
  const [locations, typeNames] = await Promise.all([
    resolveLocations(facilityRefs, supabase),
    getSdeTypeNames([b.typeId, ...b.building.byProduct.map((p) => p.productTypeId)]),
  ])
  const nameOf = (typeId: number) => typeNames[typeId] ?? `Type #${typeId}`
  const ownerName = (o: Owner) => owners.nameById.get(o.id) ?? `${o.kind} ${o.id}`
  const installerIds = b.building.installers.map((i) => i.installerId)
  const { data: directory } =
    installerIds.length === 0
      ? { data: [] as Array<{ character_id: number | string; name: string | null }> }
      : await supabase.from('character_directory').select('character_id, name').in('character_id', installerIds)
  const installerNames = new Map((directory ?? []).map((r) => [Number(r.character_id), r.name]))
  const installerName = (characterId: number) => installerNames.get(characterId) ?? `character #${characterId}`
  const tallyOut = (t: {
    jobs: number
    delivered: number
    runsAtLeast: number
    costAtLeast: number | null
    first: string | null
    last: string | null
  }) => ({
    jobs: t.jobs,
    delivered: t.delivered,
    runs_at_least: t.runsAtLeast,
    install_cost_isk_at_least: t.costAtLeast,
    first_job: t.first,
    last_job: t.last,
  })
  return {
    kind: b.kind,
    research: {
      current: b.research.current,
      steps: b.research.steps.map((s) => ({ at: s.at, from: s.from, to: s.to, job_id: s.jobId })),
      jobs: { ...tallyOut(b.researchJobs), me_jobs: b.researchJobs.me, te_jobs: b.researchJobs.te },
      note: 'Each step is a change of ME or TE between two sightings of the blueprint row, credited to the research job that ended between them when one is on record.',
    },
    building: {
      ...tallyOut(b.building),
      note: "Runs over delivered manufacturing (and reaction) jobs that named this blueprint; one run makes the product's per-run quantity (one hull for a ship). At least: the record starts when the job extract first ran for the owner.",
      by_product: b.building.byProduct.map((p) => ({
        product: nameOf(p.productTypeId),
        jobs: p.jobs,
        runs_at_least: p.runsAtLeast,
      })),
      facilities: b.building.facilities.map((f) => ({
        facility: locations.nameFor({ id: String(f.facilityId), type: null }),
        system: locations.systemFor({ id: String(f.facilityId), type: null }),
        jobs: f.jobs,
      })),
      installers: b.building.installers.map((i) => ({ installer: installerName(i.installerId), jobs: i.jobs })),
    },
    copying: { ...tallyOut(b.copying), licensed_runs_at_least: b.copying.licensedRunsAtLeast },
    invention: { ...tallyOut(b.invention), successful_runs_at_least: b.invention.successfulRunsAtLeast },
    runs_remaining: b.runsRemaining,
    owners: b.tenures.map((t) => ({ owner: ownerName(t.owner), from: t.from, until: t.until })),
    first_seen_as_blueprint: b.debut.at,
    blueprint_versions_on_record: b.versions,
  }
}

const HOW: Record<ItemKind, string> = {
  ship: 'Write in the accent and register above. Keep what the old memory says unless the facts contradict it; add, do not rewrite. Use "at least" where the data is sampled. Never invent battles, cargo or places. On a hull with an earlier owner, keep their chapters as the ship\'s past.',
  blueprint:
    'Write as the clerk above, in the first person, in its research register. Its ledger is the blueprint section: runs built by product, the research steps as promotions, the copies made. Every count is "at least" from when the record began. Never invent a job, a pilot or a facility that is not listed.',
  module:
    'Write as the droid above: short lines, status words, numbers. A high-slot module is the thug and says so. Keep what the old memory says unless the facts contradict it. Never invent kills, targets or hulls it was not fitted to.',
  container:
    'Write as the foreman above, in the first person. Talk about what passed through (the contents section) and where it has sat. Use "at least" for every quantity; never invent cargo.',
  item: 'Write as the droid above: short lines, status words, numbers. Use only the facts in the dossier; say "no record" where there is none.',
}

const urlOf = (kind: ItemKind, itemId: number): string | null =>
  kind === 'ship' ? `/ship/${itemId}` : kind === 'container' ? `/asset/${itemId}` : null

const recall = async (ctx: ServerCtx, query: string, scope: Scope): Promise<ToolResult> => {
  const supabase = clientFor(ctx)
  if (!supabase) return textResult('Missing bearer token.')
  const owners = await fetchOwnerContext(supabase)

  const resolved = await resolveItem(supabase, owners, query, scope)
  if (!resolved.ok) return textResult(resolved.message)
  const itemId = resolved.itemId

  const input = await loadDossierInput(supabase, owners, itemId)
  const d = input == null ? null : dossier(input)
  if (d == null) {
    return textResult(
      `Item #${itemId} is not an item any of this account's characters or corporations has held. Something shared with the user has no dossier here: its history belongs to whoever recorded it.`
    )
  }
  const type = await getSdeType(d.typeId)
  const kind: ItemKind = type == null ? 'item' : kindOf(type)
  if (scope.shipsOnly && kind !== 'ship') {
    return textResult(
      `Item #${itemId} is ${type?.name ?? 'an item'}, not a ship. recall_ship answers only for hulls; recall_item answers for any singleton the user holds.`
    )
  }

  const blueprint =
    kind === 'blueprint'
      ? await loadBlueprintInput(supabase, owners, itemId).then((b) => (b == null ? null : blueprintDossier(b)))
      : null
  const held = kind === 'module' ? await heldType(supabase, owners, itemId) : null

  const [factionId, facts, blueprintFacts, readers, { data: memoryRow }, { data: versionRows }, data_refreshed] =
    await Promise.all([
      kind === 'ship' ? getSdeTypeFaction(d.typeId) : Promise.resolve(null),
      describe(supabase, owners, d, kind),
      blueprint == null ? Promise.resolve(null) : describeBlueprint(supabase, owners, blueprint),
      readersOf(supabase, itemId),
      supabase
        .from('item_memory')
        .select('id, written_by, author, body, type_id, valid_from')
        .eq('item_id', itemId)
        .maybeSingle<MemoryRow>(),
      supabase.from('item_memory_over_time').select('written_by, valid_from').eq('item_id', itemId).order('valid_from'),
      dataFreshness(supabase, kind === 'blueprint' ? BLUEPRINT_JOBS : JOBS),
    ])
  const voice = nativeVoiceOf({
    kind,
    factionId,
    raceId: type?.raceID ?? null,
    groupName: type?.groupName ?? null,
    flag: held?.flag ?? null,
    research: blueprint?.research.current ?? null,
  })
  const memory = memoryRow ?? null
  // An item with no memory may be a reassembled one whose memory the
  // extract could not place: two of its type went into one stack, and the
  // game itself no longer tells them apart. The owner's pending packs of the
  // type are the candidates (docs/ship-memory.md "Reassembly");
  // remember_item's inherit_from settles it.
  const candidates = memory == null && d.inHangar ? await pendingPacksOfType(supabase, owners, d.typeId) : []
  const before = inheritance(memory, (versionRows ?? []) as MemoryVersionLike[], d.debut.at, userIdOf(ctx))
  const currentName = d.names[d.names.length - 1]?.name ?? null

  const subject = {
    item_id: itemId,
    name: currentName,
    type: type?.name ?? `Type #${d.typeId}`,
    group: type?.groupName ?? null,
    ...(kind === 'ship' ? { hull_class: type?.groupName ?? null } : {}),
    in_hangar: d.inHangar,
    last_seen: d.lastSeen,
    versions_on_record: d.versions,
    url: urlOf(kind, itemId),
  }

  return textResult({
    kind,
    ...(kind === 'ship' ? { ship: subject } : { item: subject }),
    voice: {
      accent: voice.accent,
      origin: voice.origin,
      placed_by: voice.placed_by,
      voice_notes: voice.notes,
      register: voice.register,
      register_class: voice.register_class,
    },
    dossier: facts,
    ...(blueprintFacts == null ? {} : { blueprint: blueprintFacts }),
    memory:
      memory == null
        ? null
        : {
            version_id: Number(memory.id),
            written: memory.valid_from,
            author: memory.author,
            written_by_you: before.written_by_you,
            body: memory.body,
          },
    versions_you_can_see: (versionRows ?? []).length,
    before_you: before,
    inherit_candidates:
      candidates.length === 0
        ? null
        : {
            note: `This ${noun(scope)} has no memory, and ${candidates.length === 1 ? 'one packed item' : `${candidates.length} packed items`} of its type ${candidates.length === 1 ? 'is' : 'are'} waiting to be assembled again. If this is one of them, pass its pack_id as remember_item's inherit_from and the packed memory is carried here first; a wrong pick gives this one another item's past, so ask the player when in doubt.`,
            packs: candidates.map((c) => ({
              pack_id: c.pack_id,
              packed_item_id: c.from_item_id,
              packed_at: c.packed_at,
              place_id: c.location_id,
              stack_item_id: c.stack_item_id,
            })),
          },
    readers: {
      note:
        readers.length === 0
          ? `No share reaches this ${noun(scope)}: only its holder reads the memory. It still goes with the item if it is sold.`
          : 'Everyone these shares reach reads the memory too, and so does whoever holds the item next. Check this before naming places or pilots.',
      shares: readers,
    },
    writing: {
      based_on: memory == null ? null : Number(memory.id),
      how: HOW[kind],
    },
    data_refreshed,
  })
}

type RememberArgs = { item: string; memory: string; based_on: number | null; author?: string; inherit_from?: number }

const remember = async (ctx: ServerCtx, args: RememberArgs, scope: Scope): Promise<ToolResult> => {
  const { item, memory, based_on, author, inherit_from } = args
  const supabase = clientFor(ctx)
  if (!supabase) return textResult('Missing bearer token.')
  const owners = await fetchOwnerContext(supabase)

  const resolved = await resolveItem(supabase, owners, item, scope)
  if (!resolved.ok) return textResult(resolved.message)
  const itemId = resolved.itemId

  const valid = validateMemory(memory)
  if (!valid.ok) return textResult(valid.message)

  // The function refuses an unheld item itself (42501); asking first gives
  // the type for the "not a ship" answer and a plainer message.
  const held = await heldType(supabase, owners, itemId)
  if (held == null) return textResult(writeFailure({ code: '42501' }, itemId))
  const type = await getSdeType(held.typeId)
  const kind: ItemKind = type == null ? 'item' : kindOf(type)
  if (scope.shipsOnly && kind !== 'ship') {
    return textResult(
      `Item #${itemId} is ${type?.name ?? 'an item'}, not a ship. remember_ship writes only for hulls; remember_item writes for any singleton the user holds.`
    )
  }

  // A carry settles an ambiguous reassembly before the write: the packed
  // item's memory becomes this one's first version, and the new text is
  // written on top of it, so the lineage is one chain. inheritMemory
  // refuses an item that already has a memory, so based_on must be null.
  let basedOn = based_on
  let inherited: { pack_id: number; from_item_id: number; version_id: number } | undefined
  if (inherit_from != null) {
    if (based_on != null) {
      return textResult(
        'inherit_from carries a packed memory onto an item that has none; this call also passes based_on. Pass based_on null to inherit, or drop inherit_from to write on top of the current memory.'
      )
    }
    const carried = await inheritMemory(supabase, owners, { itemId, packId: inherit_from })
    if (!carried.ok) return textResult(carried.message)
    basedOn = carried.versionId
    inherited = { pack_id: inherit_from, from_item_id: carried.fromItemId, version_id: carried.versionId }
  }

  const { data, error } = await supabase.rpc('item_memory_write', {
    p_item_id: itemId,
    p_body: valid.body,
    p_based_on: basedOn,
    p_author: authorOf(author),
  })
  if (error) {
    return textResult(
      inherited == null
        ? writeFailure(error, itemId)
        : `${writeFailure(error, itemId)} The packed memory of item #${inherited.from_item_id} was carried onto this item first (version ${inherited.version_id}) and stays; call ${recallTool(scope)} and write on top of it.`
    )
  }

  const readers = await readersOf(supabase, itemId)
  const subject = { item_id: itemId, type: type?.name ?? `Type #${held.typeId}`, url: urlOf(kind, itemId) }
  return textResult({
    kind,
    ...(kind === 'ship' ? { ship: subject } : { item: subject }),
    version_id: Number(data),
    replaced_version_id: basedOn,
    ...(inherited == null ? {} : { inherited }),
    characters: valid.body.length,
    readers: {
      note:
        readers.length === 0
          ? 'No share reaches this item: only its holder reads the memory. It goes with the item if it is sold.'
          : 'Everyone these shares reach reads this text now, and so will whoever holds the item next.',
      shares: readers,
    },
    note: 'Stored. Every version is kept; the next write passes this version_id as based_on.',
  })
}

const SUBJECT_DESCRIPTION = {
  item: 'The item: its item id (e.g. "1041234567890"), its in-game name for a ship or container (e.g. "Rusty Kettle"), or a type name for something unnamed (e.g. "Vexor Blueprint"); a type name must pick out one item among what the user holds, else the matches are listed by id',
  ship: 'The ship: its item id (e.g. "1041234567890") or its name as named in game (e.g. "Rusty Kettle")',
}

const rememberFields = (scope: Scope) => ({
  memory: z
    .string()
    .min(1)
    .max(MAX_MEMORY_LENGTH)
    .describe(
      `The whole new memory, markdown, at most ${MAX_MEMORY_LENGTH.toLocaleString('en-US')} characters. It replaces the current text, so carry forward what should stay.`
    ),
  based_on: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      `The version_id ${recallTool(scope)} returned for the current memory, or null when the item has none yet`
    ),
  author: z
    .string()
    .max(200)
    .optional()
    .describe('The name of the client writing, e.g. "Claude" or "Aura" (default "mcp"); provenance only'),
  inherit_from: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The pack_id of one of ${recallTool(scope)}'s inherit_candidates: the packed item this one was assembled from. Its memory is carried here before the write, so based_on must be null. Ask the player which candidate it is when there is more than one.`
    ),
})

const REMEMBER_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
const RECALL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false }

export const registerMemoryTools = (server: McpServer): void => {
  const generic: Scope = { shipsOnly: false }
  const ships: Scope = { shipsOnly: true }

  server.registerTool(
    'recall_item',
    {
      title: 'Recall what an item knows about itself',
      description:
        "Everything one of the user's held singleton items knows about itself, for writing its memory in its own voice. For a ship: where it first appeared and where it came from (built, contracted, bought or unpacked, inferred with a confidence), every dock and how long it stayed, who has flown it, what it has carried, its fuel, its fit and refits. For a blueprint: its research steps, every manufacturing job run with it and the hulls built by product, its copies and inventions — all recorded against its own item id, so nothing is inferred. For a container: what has passed through it. For a module or anything else: where it has been and whose it was. Also the native voice its memory should be written in (a ship's accent and register; a blueprint is a clerk; a module a droid, a high-slot one a thug), the memory it already carries with the version id a later write builds on, who can read it (every share reaching the item, a container above it or its place), and whether the current text was written by someone who held it before. Every figure is an at-least figure from the extracts' samples. Give the item as its item id, its in-game name (ships and containers), or a type name (e.g. \"Vexor Blueprint\"); a type name must pick out one held item, else the matches are listed by id.",
      annotations: RECALL_ANNOTATIONS,
      inputSchema: z.object({ item: z.string().min(1).describe(SUBJECT_DESCRIPTION.item) }),
    },
    async ({ item }, ctx): Promise<ToolResult> => recall(ctx, item, generic)
  )

  server.registerTool(
    'recall_ship',
    {
      title: 'Recall what a ship knows about itself',
      description:
        "recall_item for hulls alone: everything one of the user's ships knows about itself — where it first appeared and where it came from (built, contracted, bought or unpacked, inferred and marked with a confidence), every dock and how long it stayed, who has flown it, what it has carried, how it keeps its fuel, its fit and how often it was refitted, and whether it is still in the hangar — plus the accent and register its memory should be written in, the memory it already carries with the version id a later write builds on, who can read that memory, and whether the current text was written by someone who owned the hull before. Every figure is an at-least figure from 6-hourly samples. Give the ship as its item id or its in-game name; a name must pick out one hull among the user's current and past ships. For a blueprint, module or container, call recall_item.",
      annotations: RECALL_ANNOTATIONS,
      inputSchema: z.object({ ship: z.string().min(1).describe(SUBJECT_DESCRIPTION.ship) }),
    },
    async ({ ship }, ctx): Promise<ToolResult> => recall(ctx, ship, ships)
  )

  server.registerTool(
    'remember_item',
    {
      title: "Write an item's memory",
      description:
        "Store the next version of one of the user's held items' memory: the whole text, in markdown, in the item's own voice (call recall_item first for the facts, the voice, the current text and who will read it). Pass based_on as the version_id recall_item returned, or null when the item has no memory yet; if the memory changed since it was read, this refuses and says to recall again — it never merges. On an item with no memory, inherit_from names one of recall_item's inherit_candidates (a repackaged item's memory waiting for its reassembly): that memory is carried onto this item first and the new text written on top of it. Only the character or corporation holding the item now can write; every version is kept, and the memory goes with the item if it is sold. Nothing in the game changes and no ESI call is made.",
      annotations: REMEMBER_ANNOTATIONS,
      inputSchema: z.object({ item: z.string().min(1).describe(SUBJECT_DESCRIPTION.item), ...rememberFields(generic) }),
    },
    async (args, ctx): Promise<ToolResult> => remember(ctx, args, generic)
  )

  server.registerTool(
    'remember_ship',
    {
      title: "Write a ship's memory",
      description:
        "remember_item for hulls alone: store the next version of one of the user's ships' memory, the whole text in markdown in the ship's own voice (call recall_ship first). Pass based_on as the version_id recall_ship returned, or null when the ship has no memory yet; a stale based_on is refused and never merged. inherit_from names one of recall_ship's inherit_candidates for a hull with no memory. Only the character or corporation holding the ship now can write; every version is kept, and the memory goes with the hull if it is sold. Nothing in the game changes and no ESI call is made.",
      annotations: REMEMBER_ANNOTATIONS,
      inputSchema: z.object({ ship: z.string().min(1).describe(SUBJECT_DESCRIPTION.ship), ...rememberFields(ships) }),
    },
    async ({ ship, ...rest }, ctx): Promise<ToolResult> => remember(ctx, { ...rest, item: ship }, ships)
  )
}
