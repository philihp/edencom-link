import { createServiceClient } from '@/utils/supabase/service'

// Dark-launch flag names live here so callers can't typo them apart.
export const GRAPHQL_FLAG = 'graphql'
export const LINK_FLAG = 'link'
export const FIT_UI_FLAG = 'fit-ui'

// Every flag the Chancellor tools offer as a checkbox, with the copy shown
// beside it. A flag an account already carries that isn't listed here still
// renders (as an unlabelled checkbox), so a hand-set flag is never silently
// dropped when a Chancellor saves.
export const KNOWN_FLAGS: { flag: string; label: string }[] = [
  { flag: GRAPHQL_FLAG, label: 'GraphQL API and its playground (/graphql)' },
  { flag: LINK_FLAG, label: 'Links — Data Links, saved queries issued to others (/link)' },
  { flag: FIT_UI_FLAG, label: 'Our own ship-fitting stack, in progress (/item/[itemId])' },
]

// user_settings.flags is the per-user dark-launch flag list (see the
// add_user_settings_flags migration, whose comment points at this module).
// Read with the service role, mirroring isChancellor: callable from api_token
// contexts that carry no Supabase session. A missing user_settings row means
// no flags. Chancellors set them on /account/settings/chancellor.
export const hasFlag = async (userId: string, flag: string): Promise<boolean> => {
  const service = createServiceClient()
  const { data } = await service.from('user_settings').select('flags').eq('user_id', userId).maybeSingle()
  return ((data?.flags ?? []) as string[]).includes(flag)
}
