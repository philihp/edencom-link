// One marshalled fitting, addressed by its content hash
// (docs/fitting-marshal.md).
//
//   GET    — the archive file: ESI's own fitting object, nothing added.
//   PUT    — store a fit in the archive WITHOUT touching ESI. `400` when the
//            body does not hash to the path; idempotent otherwise.
//   DELETE — remove it from the archive. Permanent, and still no ESI call.
//
// In the FUSE client (PR 4) these are `cat`, `cp` into and `rm` from the
// `Marshalled/` folder. The handle is the hash and nothing else: a fitting id
// (digits) or a restore key (uuid) here is not a handle, since neither names a
// fit that is out of the game. Moving a LIVE fit into the archive is the
// existing DELETE /api/fittings/{characterId}/{fittingId} with `?marshal=1`
// (PR 2), so that the body stored is the one ESI handed back at the moment of
// the delete — this route only ever stores what the caller already holds.
import { NextResponse } from 'next/server'

import { contentHash, parseArchiveFitting } from '@/fittingArchive'
import { withServerTiming } from '@/serverTiming'

import {
  authorize,
  deleteMarshalled,
  errorResponse,
  isFailure,
  readMarshalled,
  requestSource,
  storeMarshalled,
  toMarshalledFile,
} from '../../lib'
import { parseMarshalledHandle } from '../../marshalledHandle'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ hash: string }> }

const NOT_A_HANDLE = {
  error: 'Not a content hash. A marshalled fitting is addressed by the sha256 of its content, 64 hex characters.',
}

export const GET = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const hash = parseMarshalledHandle((await context.params).hash)
  if (hash === null) return NextResponse.json(NOT_A_HANDLE, { status: 404 })

  const row = await readMarshalled(caller, hash)
  if (isFailure(row)) return errorResponse(row)
  if (!row) return NextResponse.json({ error: 'No such marshalled fitting' }, { status: 404 })

  // Pretty-printed with a trailing newline, as the live archive file is: the
  // body is a file the player keeps, not a wire format.
  return new NextResponse(`${JSON.stringify(toMarshalledFile(row), null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
})

export const PUT = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const hash = parseMarshalledHandle((await context.params).hash)
  if (hash === null) return NextResponse.json(NOT_A_HANDLE, { status: 404 })

  const parsed = parseArchiveFitting(await request.text())
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  // The path must be the body's own hash, checked BEFORE anything is stored.
  // Accepting a mismatch would make the handle a label rather than an
  // identity; the refusal carries the hash the body actually has, so a client
  // that computed it differently (parseArchiveFitting trims the name, for one)
  // can retry at the right address. A 400 has no side effect.
  const actual = contentHash(parsed.fitting)
  if (actual !== hash) {
    return NextResponse.json(
      { error: `The fitting hashes to ${actual}, not ${hash}. PUT it there.`, content_hash: actual },
      { status: 400 }
    )
  }

  const stored = await storeMarshalled(caller, parsed.fitting, { source: requestSource(request) })
  if (isFailure(stored)) return errorResponse(stored)

  return NextResponse.json(
    { content_hash: stored.content_hash, created: stored.created },
    { status: stored.created ? 201 : 200 }
  )
})

export const DELETE = withServerTiming(async (request: Request, context: Context) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const hash = parseMarshalledHandle((await context.params).hash)
  if (hash === null) return NextResponse.json(NOT_A_HANDLE, { status: 404 })

  const deleted = await deleteMarshalled(caller, hash)
  if (isFailure(deleted)) return errorResponse(deleted)
  if (!deleted) return NextResponse.json({ error: 'No such marshalled fitting' }, { status: 404 })
  return NextResponse.json({ deleted: true, content_hash: hash })
})
