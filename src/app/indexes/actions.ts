'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getSdeSystem, searchSdeSystems } from '@/sdeSystems'
import { createClient } from '@/utils/supabase/server'

// Autocomplete backing the "watch a system" search box. Resolved from the
// locally generated SDE data (src/sdeSystems.ts) — no ESI call.
export const searchSystems = async (query: string): Promise<[systemID: number, name: string, security: number][]> =>
  searchSdeSystems(query, 8).map((s) => [s.systemID, s.name, s.security])

const requireUser = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) redirect('/account/login')
  return { supabase, userId: user.id }
}

// Add a system to the caller's watch list. Invoked from the search results, so
// it takes the id directly; the SDE lookup rejects ids that aren't real
// known-space systems. New rows are appended to the end of the drag order;
// the upsert (with ignoreDuplicates) tolerates re-adding an already-watched
// system without disturbing its existing position.
export const watchSystem = async (systemId: number) => {
  if (!getSdeSystem(Number(systemId))) return
  const { supabase, userId } = await requireUser()
  const { data: last } = await supabase
    .from('watched_system')
    .select('position')
    .eq('user_id', userId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const position = (last?.position ?? -1) + 1
  await supabase
    .from('watched_system')
    .upsert(
      { user_id: userId, system_id: Number(systemId), position },
      { onConflict: 'user_id,system_id', ignoreDuplicates: true }
    )
  revalidatePath('/indexes')
}

// Persist a drag-reordered watch list: rewrites every row's position to match
// the given order in one upsert. Called with the caller's full watch list, so
// this always leaves position a dense 0..n-1 sequence with no gaps.
export const reorderWatchedSystems = async (systemIds: number[]) => {
  const { supabase, userId } = await requireUser()
  await supabase.from('watched_system').upsert(
    systemIds.map((systemId, position) => ({ user_id: userId, system_id: systemId, position })),
    { onConflict: 'user_id,system_id' }
  )
  revalidatePath('/indexes')
}

// Remove a system from the caller's watch list. Invoked from a plain form in
// the server-rendered table, so it takes FormData. RLS already scopes the
// delete to the caller's own rows; the explicit user_id filter is belt and
// braces.
export const unwatchSystem = async (formData: FormData) => {
  const systemId = Number(formData.get('system_id'))
  if (!Number.isFinite(systemId)) return
  const { supabase, userId } = await requireUser()
  await supabase.from('watched_system').delete().eq('user_id', userId).eq('system_id', systemId)
  revalidatePath('/indexes')
}
