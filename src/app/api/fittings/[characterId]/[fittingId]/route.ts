// One fitting, addressed by a handle.
//
//   GET    — the archive file: ESI's own fitting object, nothing added.
//   PUT    — restore an archived fitting into EVE under a key you minted.
//   DELETE — archive it, i.e. store it here in full and remove it from EVE,
//            freeing one of the character's 500 saved-fitting slots.
//
// In the FUSE client these are `cat`, `cp` and `rm` (docs/fitting-fuse.md).
//
// The handle in the path is one of two things, and which one it is says what
// you are naming:
//
//   * a **number** — the game's own `fitting_id`, for a fit EVE already has.
//     This is what GET and DELETE address.
//   * a **uuid** — a key the caller mints for a restore, because the fitting
//     it creates does not exist yet and CCP, not us, will assign its id. PUT
//     addresses this one; GET resolves it too, once the restore has run, so
//     the URI you wrote to is a URI you can read back.
//
// DELETE is the only irreversible thing this deployment can do to a player's
// game state, so it goes the long way round every time: fresh ESI listing,
// whole fit written to fitting_write_log, then the delete. See archiveFitting.
import { NextResponse } from 'next/server'

import { parseArchiveFitting, toArchiveFitting } from '@/fittingArchive'
import { withServerTiming } from '@/serverTiming'

import {
  archiveFitting,
  authorize,
  type Caller,
  errorResponse,
  isFailure,
  ownCharacter,
  type Registration,
  restoreFitting,
} from '../../lib'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ characterId: string; fittingId: string }> }

// ESI numbers fittings from 1 per character, so a bare number is the game's id.
const parseFittingId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null)

// A caller-minted restore key. Any unique uuid will do — it is never shown to
// CCP and never becomes the fitting's identity, it just names the attempt.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const parseRequestId = (raw: string): string | null => (UUID.test(raw) ? raw.toLowerCase() : null)

const NOT_A_HANDLE = { error: 'Not a fitting id or a request id' }

// The archive file for one of the character's live fittings.
const archiveFile = async (caller: Caller, registration: Registration, fittingId: number) => {
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
}

export const GET = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId, fittingId: handle } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const fittingId = parseFittingId(handle)
  if (fittingId !== null) return archiveFile(caller, registration, fittingId)

  const requestId = parseRequestId(handle)
  if (requestId === null) return NextResponse.json(NOT_A_HANDLE, { status: 404 })

  // A restore key resolves through the write log to whatever EVE ended up
  // calling the fit.
  const { data } = await caller.supabase
    .from('fitting_write_log')
    .select('fitting_id')
    .eq('request_id', requestId)
    .eq('registration_id', registration.registration_id)
    .eq('status', 'ok')
    .maybeSingle<{ fitting_id: number | null }>()
  if (!data?.fitting_id) return NextResponse.json({ error: 'No such fitting' }, { status: 404 })
  return archiveFile(caller, registration, Number(data.fitting_id))
})

export const PUT = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId, fittingId: handle } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const requestId = parseRequestId(handle)
  if (requestId === null) {
    // Notably this is where `PUT /{characterId}/{fittingId}` lands. A restore
    // cannot be addressed by the game's id — EVE assigns a *new* one every
    // time a fit is saved, so the id in an archive file names nothing that
    // will exist after this call.
    return NextResponse.json(
      { error: 'A restore is addressed by a uuid you mint, not by a fitting id — EVE assigns the fitting id itself.' },
      { status: 400 }
    )
  }

  const parsed = parseArchiveFitting(await request.text())
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const source = request.headers.get('x-edencom-source') === 'fuse' ? 'fuse' : 'api'
  const result = await restoreFitting(caller, registration, requestId, parsed.fitting, source)
  if (isFailure(result)) return errorResponse(result)

  // 201 for a fit EVE didn't have, 200 for one it already did — whether
  // because this exact request was replayed or because the same fit is already
  // saved under a different key. Either way no slot was spent twice.
  return NextResponse.json(
    { fitting_id: result.fitting_id, created: result.created, character_id: registration.character_id },
    { status: result.created ? 201 : 200 }
  )
})

export const DELETE = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId, fittingId: handle } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const fittingId = parseFittingId(handle)
  if (fittingId === null) return NextResponse.json(NOT_A_HANDLE, { status: 404 })

  const source = request.headers.get('x-edencom-source') === 'fuse' ? 'fuse' : 'api'
  const result = await archiveFitting(caller, registration, fittingId, source)
  if (isFailure(result)) return errorResponse(result)

  // The deleted fit comes back in the response. A client that archived without
  // saving a copy first still ends up holding one, and `rm` can be made to
  // print what it removed.
  return NextResponse.json({ archived: result.archived })
})
