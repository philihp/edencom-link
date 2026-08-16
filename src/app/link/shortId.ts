// The emit side of truncated link ids: the shortest path id that resolves
// back to this link, for the URLs the share dialog and the MCP tools hand
// out. expandLinkId (access.ts) takes the OLDEST-created match, so the prefix
// only has to beat links created no later than this one — anything newer
// loses the tie on its own, which is also why a short link emitted today can
// never be captured by a link created tomorrow.
//
// Service role on purpose: the contest spans every user's links, exactly
// like resolution does. Only ids and created_at are read, and only to size
// the prefix — nothing else leaves the function. Any doubt (query error, the
// link missing) falls back to the full id, which always works.
import { createServiceClient } from '@/utils/supabase/service'
import { shortestUuidPrefix, uuidPrefixRange } from './uuidPrefix'

export const shortLinkId = async (linkId: string): Promise<string> => {
  const range = uuidPrefixRange(linkId.slice(0, 8))
  if (!range) return linkId

  const service = createServiceClient()
  const { data, error } = await service.from('link').select('id, created_at').gte('id', range.low).lte('id', range.high)
  if (error || !data) return linkId

  const rows = data as Array<{ id: string; created_at: string }>
  const self = rows.find((r) => r.id === linkId)
  if (!self) return linkId

  // <= rather than <: a same-instant sibling would make resolution order
  // undefined, so it must be beaten too, not tied with.
  const cutoff = new Date(self.created_at).getTime()
  const contested = rows.filter((r) => r.id !== linkId && new Date(r.created_at).getTime() <= cutoff).map((r) => r.id)
  return shortestUuidPrefix(linkId, contested)
}
