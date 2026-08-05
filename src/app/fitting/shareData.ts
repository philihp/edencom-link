// Share-dialog data for a fitting (docs/sharing-layer/05-supersede-fittings.md)
// — the fitting counterpart of src/app/asset/shareData.ts, over the unified
// character_fitting_share row. Returns null unless the caller owns the
// registration (RLS-proved) and the fit exists.
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  fetchShareAudiences,
  shareRowToState,
  type OwnRegistration,
  type ShareDialogData,
  type ShareRowLike,
} from '../asset/shareData'

export const fetchFittingShareDialogData = async (
  supabase: SupabaseClient,
  registrationId: string,
  fittingId: string
): Promise<ShareDialogData | null> => {
  const [{ data: regs }, { data: fit }] = await Promise.all([
    supabase.from('registration').select('id, corporation_id'),
    supabase
      .from('character_fitting')
      .select('fitting_id')
      .eq('registration_id', registrationId)
      .eq('fitting_id', fittingId)
      .maybeSingle<{ fitting_id: number | string }>(),
  ])
  const own = (regs ?? []) as OwnRegistration[]
  if (!fit || !own.some((r) => r.id === registrationId)) return null

  const { corporations, alliances } = await fetchShareAudiences(supabase, own)

  const { data: shareRow } = await supabase
    .from('character_fitting_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('registration_id', registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle<ShareRowLike>()

  return { share: shareRowToState(shareRow), corporations, alliances, hasLegacyToken: false }
}
