// Type-name search backed by the nightly-mirrored SDE tables via the DB-backed
// loader (src/sdeTypes.ts), exposed for client-side autocomplete
// (src/app/blueprint/typeSearch.tsx via src/app/blueprint/actions.ts).
import { NextRequest, NextResponse } from 'next/server'

import { withServerTiming } from '@/serverTiming'
import { searchSdeTypes } from '@/sdeTypes'

// Wrapped for Server-Timing (src/serverTiming.ts): the autocomplete fires on
// every keystroke, so its `sde.sde_search_type` span is the cheapest read on
// how the search RPC is behaving under real typing.
export const GET = withServerTiming(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams.get('q')
  if (!q) return NextResponse.json([])
  return NextResponse.json(await searchSdeTypes(q))
})
