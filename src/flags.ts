import { createServiceClient } from '@/utils/supabase/service'

// The flag names and catalog live in src/flagCatalog.ts (dependency-free, so
// client components can import them); re-exported here so every server caller
// keeps its single '@/flags' import.
export { FIT_UI_FLAG, GRAPHQL_FLAG, KNOWN_FLAGS, LINK_FLAG } from '@/flagCatalog'

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
