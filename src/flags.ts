import { createServiceClient } from '@/utils/supabase/service'

// Dark-launch flag names live here so callers can't typo them apart.
export const GRAPHQL_FLAG = 'graphql'
export const LENS_FLAG = 'lens'

// user_settings.flags is the per-user dark-launch flag list (see the
// add_user_settings_flags migration, whose comment points at this module).
// Read with the service role, mirroring isChancellor: callable from api_token
// contexts that carry no Supabase session. A missing user_settings row means
// no flags. Flags are set by hand for now (SQL array_append); no admin UI.
export const hasFlag = async (userId: string, flag: string): Promise<boolean> => {
  const service = createServiceClient()
  const { data } = await service.from('user_settings').select('flags').eq('user_id', userId).maybeSingle()
  return ((data?.flags ?? []) as string[]).includes(flag)
}
