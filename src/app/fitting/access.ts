// Resolves a character_fitting_share token into the fit it points at. Share
// links let anonymous visitors view one specific fitting, so this runs on the
// service-role client — which bypasses RLS — and returns only that one fit's
// row, never anything wider. Mirrors src/app/ship/access.ts's
// resolveShareToken for shared_asset_token; see character_fitting_share's
// comment in schema.sql for why the share points at (character_id,
// fitting_id) rather than character_fitting_over_time's own surrogate id.
import { createServiceClient } from '@/utils/supabase/service'
import type { FittingRow } from './fit'

export const resolveFittingShareToken = async (
  token: string,
  characterId: string,
  fittingId: string
): Promise<FittingRow | null> => {
  const supabase = createServiceClient()

  const { data: share } = await supabase
    .from('character_fitting_share')
    .select('character_id, fitting_id')
    .eq('token', token)
    .maybeSingle<{ character_id: string; fitting_id: number | string }>()
  if (!share || share.character_id !== characterId || String(share.fitting_id) !== fittingId) return null

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  return fit
}
