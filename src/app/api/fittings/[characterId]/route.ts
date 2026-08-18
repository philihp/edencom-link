// POST /api/fittings/[characterId] — restore an archived fitting into EVE.
//
// The body is an archive file verbatim: the JSON object ESI hands out for a
// fitting, which is also the JSON object it accepts back. In the FUSE client
// this is what a `cp archive/Rifter.json mount/Pilot/` turns into
// (docs/fitting-fuse.md), so the request is literally the bytes off the
// player's disk — hand-edited, truncated or foreign JSON included, which is
// why parseArchiveFitting checks every field before ESI ever sees it.
//
// `characterId` is the EVE numeric id, matching /fitting/[characterId]/…
// rather than the registration uuid the tables key on.
import { NextResponse } from 'next/server'

import { parseArchiveFitting } from '@/fittingArchive'
import { withServerTiming } from '@/serverTiming'

import { authorize, errorResponse, isFailure, ownCharacter, restoreFitting } from '../lib'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ characterId: string }> }

export const POST = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const { characterId } = await context.params
  const registration = ownCharacter(caller, characterId)
  if (isFailure(registration)) return errorResponse(registration)

  const parsed = parseArchiveFitting(await request.text())
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const source = request.headers.get('x-edencom-source') === 'fuse' ? 'fuse' : 'api'
  const result = await restoreFitting(caller, registration, parsed.fitting, source)
  if (isFailure(result)) return errorResponse(result)

  // 201 for a fit EVE didn't have, 200 for one it already did — restoring the
  // same file twice is a no-op that costs no slot, and the client says so
  // rather than pretending it wrote something.
  return NextResponse.json(
    { fitting_id: result.fitting_id, created: result.created, character_id: registration.character_id },
    { status: result.created ? 201 : 200 }
  )
})
