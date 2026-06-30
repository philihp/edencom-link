// Type-name search backed by the local SDE data baked in at build time (see
// src/buildSde.js / src/sdeTypes.ts), exposed for client-side autocomplete
// (src/app/blueprint/typeSearch.tsx via src/app/blueprint/actions.ts).
import { NextRequest, NextResponse } from 'next/server'

import { searchSdeTypes } from '@/sdeTypes'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q) return NextResponse.json([])
  return NextResponse.json(searchSdeTypes(q))
}
