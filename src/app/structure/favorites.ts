'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

// Pin/unpin a structure so it sorts to the top of /structure. A toggle, not
// separate add/remove actions: the star is one control and the row either is or
// isn't pinned.
//
// RLS pins the row to the caller (structure_favorite's "Users manage own"
// policy), so `user_id` here is a filter for the delete, not the security
// boundary. The structure id isn't validated against corp_structure on purpose:
// the page only renders a star beside structures the caller can already see, and
// a favorite that outlives its structure's visibility is a stale row, not a
// disclosure — nothing about the pin reveals anything the caller didn't supply.
export const toggleFavorite = async (structureId: string, favorite: boolean) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const id = Number(structureId)
  if (!Number.isFinite(id)) throw new Error('bad structure id')

  if (favorite) {
    // Next position, so a newly pinned structure lands at the end of the
    // favorites block rather than jumping ahead of older pins. Mirrors
    // watchSystem() on /indexes.
    const { data: last } = await supabase
      .from('structure_favorite')
      .select('position')
      .eq('user_id', user.id)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { error } = await supabase
      .from('structure_favorite')
      .upsert(
        { user_id: user.id, structure_id: id, position: (last?.position ?? -1) + 1 },
        { onConflict: 'user_id,structure_id' }
      )
    if (error) throw error
  } else {
    const { error } = await supabase.from('structure_favorite').delete().eq('user_id', user.id).eq('structure_id', id)
    if (error) throw error
  }

  revalidatePath('/structure')
}
