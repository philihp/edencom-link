// Type-name search backed by the nightly-mirrored SDE tables via the DB-backed
// loader (src/sdeTypes.ts), exposed for client-side autocomplete
// (src/app/blueprint/typeSearch.tsx via src/app/blueprint/actions.ts).
import { NextRequest, NextResponse } from 'next/server'

import { searchSdeTypes } from '@/sdeTypes'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q) return NextResponse.json([])
  return NextResponse.json(await searchSdeTypes(q))
}
