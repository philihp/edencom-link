// GET /api/fittings/marshalled — every fit the account has marshalled out of
// the game (docs/fitting-marshal.md), in one response.
//
// The account-level half of the archive index: GET /api/fittings lists what
// each character has saved in EVE, this lists what is held here instead. The
// FUSE client (PR 4) draws the two as sibling folders. Each entry is the
// archive file plus the handle to address it by (`content_hash`), the hull
// name for the filename, and where it came from. No `data_refreshed`: this
// table is authoritative, not a mirror of anything.
import { NextResponse } from 'next/server'

import { getSdeTypeNames } from '@/sdeTypes'
import { withServerTiming } from '@/serverTiming'

import { authorize, errorResponse, isFailure, listMarshalled, marshalledEntry } from '../lib'

export const dynamic = 'force-dynamic'

export const GET = withServerTiming(async (request: Request) => {
  const caller = await authorize(request)
  if (isFailure(caller)) return errorResponse(caller)

  const rows = await listMarshalled(caller)
  if (isFailure(rows)) return errorResponse(rows)

  const shipNames = await getSdeTypeNames(new Set(rows.map((r) => Number(r.ship_type_id))))
  return NextResponse.json({ marshalled: rows.map((row) => marshalledEntry(caller, shipNames, row)) })
})
