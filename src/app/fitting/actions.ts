'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { sharedFittingRoute, type FittingRow } from './fit'

// Publish one of the caller's saved fits as a corporation or alliance fitting
// (a snapshot copy into shared_fitting — see the table's comment in
// schema.sql). Everything runs on the cookie client: RLS proves the fit is
// theirs to read, and the shared_fitting insert policy proves the target is
// the publishing character's own current corp/alliance — this action adds no
// authority of its own.
export const publishFitting = async (
  characterId: string,
  fittingId: string,
  audience: 'corporation' | 'alliance'
): Promise<void> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) throw new Error('fitting not found')

  // The audience ids come from the publishing character's current membership.
  const { data: registration } = await supabase
    .from('registration')
    .select('corporation_id')
    .eq('id', characterId)
    .maybeSingle<{ corporation_id: number | null }>()
  const corporationId = registration?.corporation_id ?? null
  if (corporationId == null) throw new Error('character has no known corporation yet')

  let allianceId: number | null = null
  if (audience === 'alliance') {
    const { data: corporation } = await supabase
      .from('corporation')
      .select('alliance_id')
      .eq('corporation_id', corporationId)
      .maybeSingle<{ alliance_id: number | null }>()
    allianceId = corporation?.alliance_id ?? null
    if (allianceId == null) throw new Error('corporation is not in an alliance')
  }

  const { data: inserted, error } = await supabase
    .from('shared_fitting')
    .insert({
      audience,
      corporation_id: audience === 'corporation' ? corporationId : null,
      alliance_id: audience === 'alliance' ? allianceId : null,
      name: fit.name || `Fitting #${fit.fitting_id}`,
      description: fit.description,
      ship_type_id: fit.ship_type_id,
      items: fit.items ?? [],
      created_by: characterId,
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error

  revalidatePath('/fitting')
  redirect(sharedFittingRoute(inserted.id))
}

// Take a published fit back down. The delete policy limits this to fits the
// caller's own characters published; the eq() is just the row address.
export const unpublishFitting = async (sharedId: string): Promise<void> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { error } = await supabase.from('shared_fitting').delete().eq('id', sharedId)
  if (error) throw error

  revalidatePath('/fitting')
  redirect('/fitting')
}
