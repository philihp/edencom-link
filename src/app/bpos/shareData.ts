// Share-dialog data for an account's BPO showcase — the account-level
// counterpart of src/app/asset/shareData.ts, over the single bpo_share row.
// The subject is the caller's whole account, so there is no ownership probe to
// run beyond "they're signed in": RLS on bpo_share only ever returns their row.
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  fetchShareAudiences,
  shareRowToState,
  type OwnRegistration,
  type ShareDialogData,
  type ShareRowLike,
} from '../asset/shareData'

export const fetchBposShareDialogData = async (supabase: SupabaseClient): Promise<ShareDialogData> => {
  const { data: regs } = await supabase.from('registration').select('id, corporation_id')
  const { corporations, alliances } = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])

  const { data: shareRow } = await supabase
    .from('bpo_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .maybeSingle<ShareRowLike>()

  return { share: shareRowToState(shareRow), corporations, alliances, hasLegacyToken: false }
}
