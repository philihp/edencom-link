// Share-dialog data for an account's corpse collection — the same shape as the
// BPO showcase's (src/app/bpos/shareData.ts), over the single corpse_share
// row. The subject is the caller's whole account, so there is no ownership
// probe beyond "they're signed in": RLS on corpse_share only ever returns
// their own row.
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  fetchShareAudiences,
  shareRowToState,
  type OwnRegistration,
  type ShareDialogData,
  type ShareRowLike,
} from '../asset/shareData'

export const fetchCorpsesShareDialogData = async (supabase: SupabaseClient): Promise<ShareDialogData> => {
  const { data: regs } = await supabase.from('registration').select('id, corporation_id')
  const { corporations, alliances } = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])

  const { data: shareRow } = await supabase
    .from('corpse_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .maybeSingle<ShareRowLike>()

  return { share: shareRowToState(shareRow), corporations, alliances, hasLegacyToken: false }
}
