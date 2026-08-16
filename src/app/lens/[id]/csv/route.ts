import { NextRequest, NextResponse } from 'next/server'

import { EXPORT_CAP } from '@/app/api/graphql/filters'
import { recordRequest } from '@/observability'
import { toCsv } from '@/utils/csv'
import { resolveLens } from '../../access'
import { csvRows } from '../../flatten'
import { runLens } from '../../run'

// The Lens CSV rendering (docs/sharing-layer/07-lens.md): the lens's single
// top-level field flattened to rows for Google Sheets =IMPORTDATA(). Same
// authorization as the viewer page — the session cookie when there is one,
// otherwise the signed ?share= param, which is what Sheets uses (it carries
// no cookie). This is the surface positioned to supersede the bespoke
// api_token CSV endpoints once lenses reach parity.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> => {
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const share = searchParams.get('share')?.trim() || undefined

  const startedAt = Date.now()
  const resolved = await resolveLens(id, share)
  if (!resolved) {
    // The ok/query_failed runs report from inside runLens (where the lens's
    // root field is known); a lens that never resolved has no field to name.
    recordRequest({
      route: '/lens/[id]/csv',
      surface: 'lens_csv',
      outcome: 'not_found',
      status: 404,
      durationMs: Date.now() - startedAt,
    })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const result = await runLens(resolved.lens, {
    timing: { surface: 'lens_csv', route: '/lens/[id]/csv' },
    exporting: true,
  })
  if (result.errors.length > 0 && result.data == null) {
    return NextResponse.json({ error: result.errors.join(' — ') }, { status: 500 })
  }

  // csvRows, not lensRows: a lens selecting a nullable edge (location on an
  // asset ESI gave no location_id for) returns ragged rows, and toCsv reads its
  // header off the first one.
  const rows = csvRows(result.data)

  // `exporting` raised the per-list caps to EXPORT_CAP; a result that still
  // reaches it was almost certainly cut there, and a silently shortened CSV is
  // worse than a refusal the sheet can see (an author's own smaller `limit:` is
  // deliberate and passes untouched).
  if (rows.length >= EXPORT_CAP) {
    return NextResponse.json(
      { error: `The result hit the ${EXPORT_CAP}-row export bound — narrow the lens's filters.` },
      { status: 400 }
    )
  }

  return new NextResponse(toCsv(rows), {
    headers: { 'content-type': 'text/csv; charset=utf-8' },
  })
}
