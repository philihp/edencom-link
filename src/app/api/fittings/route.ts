// GET /api/fittings — the whole archive index, in one response.
//
// This is what the FUSE client reads to build its directory tree
// (docs/fitting-fuse.md): one entry per linked character, each holding every
// fitting that character has saved in EVE, plus — since docs/fitting-marshal.md
// PR 1 — the account's `marshalled` fits, the ones held here instead of in
// the game. A mount is 500 fits per character at most, so paging would buy
// nothing and cost the client a loop; the listing is small enough to be the
// unit.
//
// Read straight from the character_fitting mirror rather than from ESI. Browsing
// is the common case by a wide margin — a `ls` per Finder window, per keystroke
// in a save dialog — and pointing that at CCP would burn the account's error
// budget for no freshness anyone can perceive. `data_refreshed` says how old
// the mirror is so the client can show it, and the two write routes always
// verify against live ESI before they touch anything. The marshalled array
// carries no such stamp: that table is authoritative.
import { NextResponse } from 'next/server'

import { toArchiveFitting } from '@/fittingArchive'
import { getSdeTypeNames } from '@/sdeTypes'
import { withServerTiming } from '@/serverTiming'

import { authorize, errorResponse, isFailure, listMarshalled, marshalledEntry, WRITE_SCOPE } from './lib'

export const dynamic = 'force-dynamic'

type FittingRow = {
  registration_id: string
  fitting_id: number | string
  name: string | null
  description: string | null
  ship_type_id: number | string
  items: unknown
  valid_from: string
  valid_until: string
}

export const GET = withServerTiming(async (request: Request) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const registrationIds = caller.registrations.map((r) => r.registration_id)

  // Which characters may be written to at all: the ones holding a token with
  // the opt-in write scope. The client uses this to mark a character's folder
  // read-only up front, so a `rm` fails at open() with a clear message instead
  // of after a round trip to CCP.
  //
  // An empty .in() list is not a valid PostgREST filter, so an account with no
  // characters yet skips the three per-character reads; its marshalled fits
  // (copied in from a disk archive, say) still list.
  const [{ data: rows, error }, { data: writable }, { data: heartbeats }, marshalled] = await Promise.all([
    registrationIds.length > 0
      ? caller.supabase
          .from('character_fitting')
          .select('registration_id, fitting_id, name, description, ship_type_id, items, valid_from, valid_until')
          .in('registration_id', registrationIds)
          .returns<FittingRow[]>()
      : Promise.resolve({ data: [] as FittingRow[], error: null }),
    registrationIds.length > 0
      ? caller.supabase
          .from('token')
          .select('registration_id')
          .in('registration_id', registrationIds)
          .contains('scope', [WRITE_SCOPE])
          .returns<Array<{ registration_id: string }>>()
      : Promise.resolve({ data: [] as Array<{ registration_id: string }> }),
    registrationIds.length > 0
      ? caller.supabase
          .from('heartbeat')
          .select('registration_id, ended_at')
          .eq('job', 'character-fittings')
          .in('registration_id', registrationIds)
          .not('ended_at', 'is', null)
          .order('ended_at', { ascending: false })
          .limit(200)
          .returns<Array<{ registration_id: string; ended_at: string }>>()
      : Promise.resolve({ data: [] as Array<{ registration_id: string; ended_at: string }> }),
    listMarshalled(caller),
  ])
  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  if (isFailure(marshalled)) return errorResponse(marshalled)

  const writableIds = new Set((writable ?? []).map((t) => t.registration_id))
  const refreshedAt = new Map<string, string>()
  ;(heartbeats ?? []).forEach((h) => {
    if (!refreshedAt.has(h.registration_id)) refreshedAt.set(h.registration_id, h.ended_at)
  })

  // Hull names, resolved once for the whole listing. The client puts them in
  // the filename — a folder of "Hurricane — Doctrine Cane.json" is browsable
  // in a way that 500 bare fit names are not, which is the point of mounting
  // this at all.
  const shipNames = await getSdeTypeNames(
    new Set([...(rows ?? []).map((r) => Number(r.ship_type_id)), ...marshalled.map((m) => Number(m.ship_type_id))])
  )

  const byRegistration = new Map<string, FittingRow[]>()
  ;(rows ?? []).forEach((row) => {
    const list = byRegistration.get(row.registration_id)
    if (list) list.push(row)
    else byRegistration.set(row.registration_id, [row])
  })

  return NextResponse.json({
    characters: caller.registrations.map((registration) => ({
      character_id: registration.character_id,
      name: registration.name,
      writable: writableIds.has(registration.registration_id),
      data_refreshed: refreshedAt.get(registration.registration_id) ?? null,
      fittings: (byRegistration.get(registration.registration_id) ?? [])
        .map((row) => ({
          ...toArchiveFitting(row),
          ship_name: shipNames[Number(row.ship_type_id)] ?? null,
          // When this version of the fit was first seen. The client uses it as
          // the file's mtime, so an edited fit sorts to the top in Finder.
          modified: row.valid_from,
        }))
        .sort((a, b) => (a.ship_name ?? '').localeCompare(b.ship_name ?? '') || a.name.localeCompare(b.name)),
    })),
    marshalled: marshalled
      .map((row) => marshalledEntry(caller, shipNames, row))
      .sort((a, b) => (a.ship_name ?? '').localeCompare(b.ship_name ?? '') || a.name.localeCompare(b.name)),
  })
})
