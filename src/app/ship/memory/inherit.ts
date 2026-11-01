// Settling an ambiguous reassembly by hand (docs/ship-memory.md
// "Reassembly"): when two memory-bearing hulls of one type went into one
// stack, the extract carries nothing, and the owner picks which packed hull
// the assembled one was through remember_ship's inherit_from. This module is
// that pick: the checks run on the caller's bearer client, so RLS is what
// says the pack is theirs and the hull is held, and the carry itself runs on
// the service role, since item_memory_carry() is service-role only (it keeps
// the old author account on the new version, which no column grant lets an
// authenticated writer do).
//
// The checks, in order: the pack is one the caller can read (their own
// registration's or their corporation's) and still pending; the new hull is
// held by one of the caller's owners and is of the pack's type; the new hull
// has no memory yet. Each refusal says which, so the AI can tell the player.
import type { SupabaseClient } from '@supabase/supabase-js'

import { createServiceClient } from '@/utils/supabase/service'

export type Owners = { registrationIds: string[]; corporationIds: string[] }

export type PackRow = {
  id: number | string
  item_id: number | string
  type_id: number | string
  registration_id: string | null
  corporation_id: number | string | null
  stack_item_id: number | string | null
  location_id: number | string | null
  packed_at: string
}

export type InheritCandidate = {
  pack_id: number
  from_item_id: number
  type_id: number
  packed_at: string
  location_id: number | null
  stack_item_id: number | null
}

const asCandidate = (p: PackRow): InheritCandidate => ({
  pack_id: Number(p.id),
  from_item_id: Number(p.item_id),
  type_id: Number(p.type_id),
  packed_at: p.packed_at,
  location_id: p.location_id == null ? null : Number(p.location_id),
  stack_item_id: p.stack_item_id == null ? null : Number(p.stack_item_id),
})

// The caller's pending packs of one type: the memories waiting for a hull of
// that type to be assembled. RLS shows the caller only their own owners'
// packs; the owner filter is explicit besides, as everywhere a corp policy
// could widen a read.
export const pendingPacksOfType = async (
  supabase: SupabaseClient,
  owners: Owners,
  typeId: number
): Promise<InheritCandidate[]> => {
  const ors = [
    ...(owners.registrationIds.length > 0 ? [`registration_id.in.(${owners.registrationIds.join(',')})`] : []),
    ...(owners.corporationIds.length > 0 ? [`corporation_id.in.(${owners.corporationIds.join(',')})`] : []),
  ]
  if (ors.length === 0) return []
  const { data } = await supabase
    .from('item_memory_pack')
    .select('id, item_id, type_id, registration_id, corporation_id, stack_item_id, location_id, packed_at')
    .eq('type_id', typeId)
    .is('resolved_at', null)
    .or(ors.join(','))
    .order('packed_at', { ascending: false })
    .limit(50)
    .returns<PackRow[]>()
  return ((data ?? []) as PackRow[]).map(asCandidate)
}

export type InheritResult = { ok: true; versionId: number; fromItemId: number } | { ok: false; message: string }

// The type of the hull's one current asset row under the caller's owners;
// null when no owner of theirs holds it now.
const heldTypeOf = async (supabase: SupabaseClient, owners: Owners, itemId: number): Promise<number | null> => {
  const read = async (table: 'character_asset_version' | 'corp_asset_version', column: string, ids: string[]) => {
    if (ids.length === 0) return null
    const { data } = await supabase
      .from(table)
      .select('type_id')
      .eq('item_id', itemId)
      .eq('is_current', true)
      .in(column, ids)
      .maybeSingle<{ type_id: number | string }>()
    return data == null ? null : Number(data.type_id)
  }
  return (
    (await read('character_asset_version', 'registration_id', owners.registrationIds)) ??
    (await read('corp_asset_version', 'corporation_id', owners.corporationIds))
  )
}

// Carry the memory a pending pack holds onto a hull the caller holds. The
// caller's bearer client makes every check; the service client runs the one
// write. `service` is injectable for tests; it defaults to the deployment's.
export const inheritMemory = async (
  supabase: SupabaseClient,
  owners: Owners,
  { itemId, packId }: { itemId: number; packId: number },
  service: SupabaseClient = createServiceClient()
): Promise<InheritResult> => {
  const { data: pack } = await supabase
    .from('item_memory_pack')
    .select('id, item_id, type_id, registration_id, corporation_id, stack_item_id, location_id, packed_at, resolved_at')
    .eq('id', packId)
    .maybeSingle<PackRow & { resolved_at: string | null }>()
  if (pack == null) {
    return { ok: false, message: `Pack #${packId} is not one of this account's packed memories.` }
  }
  if (pack.resolved_at != null) {
    return { ok: false, message: `Pack #${packId} was already carried onto another hull.` }
  }

  const typeId = await heldTypeOf(supabase, owners, itemId)
  if (typeId == null) {
    return { ok: false, message: `Item #${itemId} is not held by any of this account's characters or corporations.` }
  }
  if (typeId !== Number(pack.type_id)) {
    return {
      ok: false,
      message: `Item #${itemId} is type #${typeId}; pack #${packId} holds the memory of a type #${pack.type_id} hull. A memory stays with its hull type.`,
    }
  }

  const { data: existing } = await supabase.from('item_memory').select('id').eq('item_id', itemId).maybeSingle()
  if (existing != null) {
    return {
      ok: false,
      message: `Item #${itemId} already has a memory. A carry never overwrites one; write on top of it with based_on instead.`,
    }
  }

  const { data, error } = await service.rpc('item_memory_carry', {
    p_from_item_id: Number(pack.item_id),
    p_to_item_id: itemId,
    p_pack_id: Number(pack.id),
  })
  if (error) return { ok: false, message: `The carry failed: ${error.message}` }
  return { ok: true, versionId: Number(data), fromItemId: Number(pack.item_id) }
}
