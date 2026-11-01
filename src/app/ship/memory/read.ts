// The one read behind the Memory panel (docs/ship-memory.md, "Display"), on
// whatever client the page hands in: the holder's cookie session (RLS shows
// the holder the current version and an author their own), or the share
// loader's service-role client, which has already resolved the share and
// stays the one gate. `asOf` is the dead-hull case: the version in force when
// the hull was last seen.
import type { SupabaseClient } from '@supabase/supabase-js'

import { memoryMeta, type MemoryMeta, type MemoryVersion, versionAsOf } from './select'

export type ShipMemory = MemoryMeta & {
  body: string
  author: string
}

export const readShipMemory = async (
  supabase: SupabaseClient,
  itemId: number | string,
  { asOf = null }: { asOf?: string | null } = {}
): Promise<ShipMemory | null> => {
  const { data } = await supabase
    .from('item_memory_over_time')
    .select('id, body, author, written_by, is_current, valid_from, valid_until')
    .eq('item_id', itemId)
    .order('valid_from')
    .returns<MemoryVersion[]>()
  const rows = data ?? []
  const shown = versionAsOf(rows, asOf)
  if (shown == null) return null
  return { body: shown.body, author: shown.author, ...memoryMeta(rows, shown) }
}
