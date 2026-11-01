// Ship memory over MCP (docs/ship-memory.md, "MCP tools"): recall_ship hands
// the player's AI everything a hull knows about itself — the dossier, the
// voice it speaks in, the memory it already carries and who can read what is
// written — so the AI can write the next version in the ship's own words.
// This module is the read side; remember_ship (PR 4) is the write.
//
// Same rules as tools.ts: every query runs on the caller's bearer client, so
// RLS scopes the rows to the reader's own data; the loader narrows them to
// the caller's own owners besides, since the asset views also show a
// recipient what was shared with them, and a shared hull is not theirs to
// remember. The DB is the only source; nothing here calls ESI.
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import { uniq } from 'ramda'
import { z } from 'zod'

import { resolveLocations, type LocationRef } from '@/app/resolveLocations'
import { SHIP_CATEGORY_ID } from '@/app/ship/[itemId]/shipRows'
import { voiceOf } from '@/app/ship/memory/accent'
import { dossier, type Dossier, type Owner, type Place } from '@/app/ship/memory/dossier'
import { loadDossierInput } from '@/app/ship/memory/load'
import { registerOf } from '@/app/ship/memory/register'
import { getSdeType, getSdeTypeFaction, getSdeTypeNames, getSdeTypes } from '@/sdeTypes'
import { escapeLike } from '@/utils/escapeLike'
import { createBearerClient } from '@/utils/supabase/bearer'

import { dataFreshness, fetchOwnerContext, textResult, type OwnerContext, type ToolResult } from './lib'
import {
  describeReader,
  type HullRow,
  inheritance,
  type MemoryVersionLike,
  parseItemId,
  pickHull,
  type Reader,
  subjectOf,
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

const HULL_COLUMNS = 'item_id, name, type_id, is_current, valid_until'

// A name over the caller's own hulls, current and dead. Corp rows carry no
// name (ESI names only a character's items), so a corp hull is reached by
// id. The name filter runs in SQL; the SDE category check keeps the match
// to ships, since a container can be named too.
const hullByName = async (supabase: SupabaseClient, owners: OwnerContext, query: string) => {
  if (owners.registrationIds.length === 0) return { ok: false as const, message: 'No linked characters.' }
  const { data } = await supabase
    .from('character_asset_over_time')
    .select(HULL_COLUMNS)
    .in('registration_id', owners.registrationIds)
    .ilike('name', `%${escapeLike(query.trim())}%`)
    .limit(500)
  const rows = (data ?? []) as HullRow[]
  const types = await getSdeTypes(uniq(rows.map((r) => Number(r.type_id))))
  const ships = rows.filter((r) => types[Number(r.type_id)]?.categoryID === SHIP_CATEGORY_ID)
  const picked = pickHull(query, ships)
  return picked.ok ? { ok: true as const, itemId: Number(picked.id) } : picked
}

type MemoryRow = MemoryVersionLike & { id: number | string; author: string; body: string; type_id: number | string }

type ShareRow = {
  item_id: number | string
  corporation_ids: Array<number | string>
  alliance_ids: Array<number | string>
  secret: string | null
  show_as_main?: boolean
}

// The share rows whose subject is the hull, a container above it, or its
// place — on the caller's own rows (the owner-manages policy) plus any
// audience row aimed at them. A recipient's own corp share rows on a corp
// hull come through the member-read policy the same way.
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

// The dossier with every id named: owners, places, types, pilots.
const describe = async (supabase: SupabaseClient, owners: OwnerContext, d: Dossier) => {
  const placeRefs: LocationRef[] = uniq(
    [...d.itinerary.map((s) => s.place), d.debut.place]
      .filter((p): p is Place => p != null)
      .map((p) => ({ id: String(p.id), type: p.type === 'item' ? null : p.type }))
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
      : `${locations.nameFor({ id: String(p.id), type: p.type === 'item' ? null : p.type })}${
          locations.systemFor({ id: String(p.id), type: p.type === 'item' ? null : p.type })
            ? ` (${locations.systemFor({ id: String(p.id), type: p.type === 'item' ? null : p.type })})`
            : ''
        }`

  const origin = d.origin
  return {
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
          : 'Inferred from the same type appearing in that record just before the hull debuted; no table links an item to the job, contract or buy that produced it.',
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
    pilots: d.pilots.map((p) => ({
      pilot: owners.nameById.get(p.registrationId) ?? p.registrationId,
      boardings: p.boardings,
      first_boarded: p.first,
      last_left: p.last,
      hours_aboard_at_least: hours(p.hours),
    })),
    cargo: {
      note: 'At-least figures: each item counts once at the most of it ever seen aboard, and anything loaded and unloaded between two extracts is missed.',
      volume_m3_at_least: d.cargo.volumeAtLeast,
      distinct_types: d.cargo.distinctTypes,
      lines: d.cargo.lines.slice(0, 40).map((l) => ({ item: nameOf(l.typeId), quantity: l.maxQuantity, m3: l.volume })),
    },
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

export const registerMemoryTools = (server: McpServer): void => {
  server.registerTool(
    'recall_ship',
    {
      title: 'Recall what a ship knows about itself',
      description:
        "Everything one of the user's ships knows about itself, for writing its memory in its own voice: where it first appeared and where it came from (built, contracted, bought or unpacked, inferred and marked with a confidence), every dock and how long it stayed, who has flown it, what it has carried, how it keeps its fuel, its fit and how often it was refitted, and whether it is still in the hangar. Also the accent and register its memory should be written in (from the hull's faction, race and class), the memory it already carries with the version id a later write builds on, who can read that memory (every share reaching the hull, a container above it or its place), and whether the current text was written by someone who owned the hull before. Every figure is an at-least figure from 6-hourly samples. Give the ship as its item id or its in-game name; a name must pick out one hull among the user's current and past ships.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        ship: z
          .string()
          .min(1)
          .describe('The ship: its item id (e.g. "1041234567890") or its name as named in game (e.g. "Rusty Kettle")'),
      }),
    },
    async ({ ship }, ctx): Promise<ToolResult> => {
      const supabase = clientFor(ctx)
      if (!supabase) return textResult('Missing bearer token.')
      const owners = await fetchOwnerContext(supabase)

      const byId = parseItemId(ship)
      const resolved = byId == null ? await hullByName(supabase, owners, ship) : { ok: true as const, itemId: byId }
      if (!resolved.ok) return textResult(resolved.message)
      const itemId = resolved.itemId

      const input = await loadDossierInput(supabase, owners, itemId)
      const d = input == null ? null : dossier(input)
      if (d == null) {
        return textResult(
          `Item #${itemId} is not a hull any of this account's characters or corporations has held. A ship someone shared with the user has no dossier here: its history belongs to whoever recorded it.`
        )
      }
      const type = await getSdeType(d.typeId)
      if (type?.categoryID !== SHIP_CATEGORY_ID) {
        return textResult(
          `Item #${itemId} is ${type?.name ?? 'an item'}, not a ship. The memory storage takes any item, but this tool answers only for hulls.`
        )
      }

      const [factionId, facts, readers, { data: memoryRow }, { data: versionRows }, data_refreshed] = await Promise.all(
        [
          getSdeTypeFaction(d.typeId),
          describe(supabase, owners, d),
          readersOf(supabase, itemId),
          supabase
            .from('item_memory')
            .select('id, written_by, author, body, type_id, valid_from')
            .eq('item_id', itemId)
            .maybeSingle<MemoryRow>(),
          supabase
            .from('item_memory_over_time')
            .select('written_by, valid_from')
            .eq('item_id', itemId)
            .order('valid_from'),
          dataFreshness(supabase, JOBS),
        ]
      )
      const voice = voiceOf({ factionId, raceId: type.raceID })
      const register = registerOf(type.groupName)
      const memory = memoryRow ?? null
      const before = inheritance(memory, (versionRows ?? []) as MemoryVersionLike[], d.debut.at, userIdOf(ctx))
      const currentName = d.names[d.names.length - 1]?.name ?? null

      return textResult({
        ship: {
          item_id: itemId,
          name: currentName,
          type: type.name,
          hull_class: type.groupName,
          in_hangar: d.inHangar,
          last_seen: d.lastSeen,
          versions_on_record: d.versions,
          url: `/ship/${itemId}`,
        },
        voice: {
          accent: voice.accent,
          origin: voice.label,
          placed_by: voice.from,
          voice_notes: voice.notes,
          register: register.register,
          register_class: register.label,
        },
        dossier: facts,
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
        readers: {
          note:
            readers.length === 0
              ? 'No share reaches this hull: only its holder reads the memory. It still goes with the ship if it is sold.'
              : 'Everyone these shares reach reads the memory too, and so does whoever owns the hull next. Check this before naming places or pilots.',
          shares: readers,
        },
        writing: {
          based_on: memory == null ? null : Number(memory.id),
          how: 'Write in the accent and register above. Keep what the old memory says unless the facts contradict it; add, do not rewrite. Use "at least" where the data is sampled. Never invent battles, cargo or places. On a hull with an earlier owner, keep their chapters as the ship\'s past.',
        },
        data_refreshed,
      })
    }
  )
}
