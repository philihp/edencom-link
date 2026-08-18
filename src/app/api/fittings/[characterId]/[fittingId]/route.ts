// One saved fitting.
//
//   GET    — the archive file: ESI's own fitting object, nothing added.
//   DELETE — archive it, i.e. store it here in full and remove it from EVE,
//            freeing one of the character's 500 saved-fitting slots.
//
// In the FUSE client these are `cat` and `rm` (docs/fitting-fuse.md). DELETE is
// the only irreversible thing this deployment can do to a player's game state,
// so it goes the long way round every time: fresh ESI listing, whole fit
// written to fitting_write_log, then the delete. See archiveFitting.
import { NextResponse } from 'next/server'

import { toArchiveFitting } from '@/fittingArchive'
import { withServerTiming } from '@/serverTiming'

import { archiveFitting, authorize, errorResponse, isFailure, ownCharacter } from '../../lib'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ characterId: string; fittingId: string }> }

// The fitting id in the URL, or null when it isn't one. ESI numbers fittings
// from 1 per character, so anything non-numeric names no fit that could exist.
const parseFittingId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null)

export const GET = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId, fittingId: rawFittingId } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const fittingId = parseFittingId(rawFittingId)
  if (fittingId === null) return NextResponse.json({ error: 'Not a fitting id' }, { status: 404 })

  const { data, error } = await caller.supabase
    .from('character_fitting')
    .select('fitting_id, name, description, ship_type_id, items')
    .eq('registration_id', registration.registration_id)
    .eq('fitting_id', fittingId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'No such fitting' }, { status: 404 })

  // Pretty-printed with a trailing newline: the response body is a file the
  // player keeps, diffs and greps, not a wire format.
  return new NextResponse(`${JSON.stringify(toArchiveFitting(data), null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
})

export const DELETE = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId, fittingId: rawFittingId } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const fittingId = parseFittingId(rawFittingId)
  if (fittingId === null) return NextResponse.json({ error: 'Not a fitting id' }, { status: 404 })

  const source = request.headers.get('x-edencom-source') === 'fuse' ? 'fuse' : 'api'
  const result = await archiveFitting(caller, registration, fittingId, source)
  if (isFailure(result)) return errorResponse(result)

  // The deleted fit comes back in the response. A client that archived without
  // saving a copy first still ends up holding one, and `rm` can be made to
  // print what it removed.
  return NextResponse.json({ archived: result.archived })
})
