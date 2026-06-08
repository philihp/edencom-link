import { createServiceClient } from '@/utils/supabase/service'

type Resolved =
  | { ok: true; supabase: ReturnType<typeof createServiceClient>; characterIds: string[] }
  | { ok: false; status: number; error: string }

// Resolve a per-user api_token (from the IMPORTDATA query string) to the owner's
// registration ids. The request carries no Supabase session, so this uses the
// service role and scopes by the resolved user_id. Returns a discriminated result
// the caller turns straight into a JSON response. Shared by the /api/* endpoints.
export const resolvePlayer = async (token: string | undefined): Promise<Resolved> => {
  if (!token) {
    return { ok: false, status: 401, error: 'Missing api token' }
  }

  const supabase = createServiceClient()

  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('api_token', token)
    .maybeSingle()
  if (settingsError) {
    return { ok: false, status: 500, error: 'Lookup failed' }
  }
  if (!settings) {
    return { ok: false, status: 401, error: 'Invalid api token' }
  }

  const { data: characters, error: charactersError } = await supabase
    .from('registration')
    .select('id')
    .eq('user_id', settings.user_id)
  if (charactersError) {
    return { ok: false, status: 500, error: 'Lookup failed' }
  }

  return { ok: true, supabase, characterIds: (characters ?? []).map((c) => c.id) }
}
