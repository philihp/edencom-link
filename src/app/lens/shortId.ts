// The emit side of truncated lens ids: the shortest path id that resolves
// back to this lens, for the URLs the share dialog and the MCP tools hand
// out. expandLensId (access.ts) takes the OLDEST-created match, so the prefix
// only has to beat lenses created no later than this one — anything newer
// loses the tie on its own, which is also why a short link emitted today can
// never be captured by a lens created tomorrow.
//
// Service role on purpose: the contest spans every user's lenses, exactly
// like resolution does. Only ids and created_at are read, and only to size
// the prefix — nothing else leaves the function. Any doubt (query error, the
// lens missing) falls back to the full id, which always works.
import { createServiceClient } from '@/utils/supabase/service'
import { shortestUuidPrefix, uuidPrefixRange } from './uuidPrefix'

export const shortLensId = async (lensId: string): Promise<string> => {
  const range = uuidPrefixRange(lensId.slice(0, 8))
  if (!range) return lensId

  const service = createServiceClient()
  const { data, error } = await service.from('lens').select('id, created_at').gte('id', range.low).lte('id', range.high)
  if (error || !data) return lensId

  const rows = data as Array<{ id: string; created_at: string }>
  const self = rows.find((r) => r.id === lensId)
  if (!self) return lensId

  // <= rather than <: a same-instant sibling would make resolution order
  // undefined, so it must be beaten too, not tied with.
  const cutoff = new Date(self.created_at).getTime()
  const contested = rows.filter((r) => r.id !== lensId && new Date(r.created_at).getTime() <= cutoff).map((r) => r.id)
  return shortestUuidPrefix(lensId, contested)
}
