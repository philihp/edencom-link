'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

import { sso } from './sso'
import { getEnabledScopes } from './userScopes'

export const register = async (formData: FormData) => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  // A brand new player (no characters yet and no saved grant preferences) is sent
  // to choose what to share before we send them on to EVE SSO.
  const { count } = await supabase.from('registration').select('id', { count: 'exact', head: true })
  const { data: settings } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if ((count ?? 0) === 0 && !settings) {
    redirect('/settings/grants?from=characters')
  }

  const scopes = await getEnabledScopes(supabase, user.id)
  redirect(sso.getRedirectUrl('state', scopes))
}

// Refresh assets for just the signed-in player's characters, on demand. This
// runs the same extract as the scheduled Assets workflow (src/assets.js) but
// scoped to the characters this user owns. RLS scopes the registration read to
// the caller; the extract itself writes with the service role, so we only hand
// it the ids the user is actually allowed to refresh.
export const refreshAssets = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const { data: characters } = await supabase.from('registration').select('id')
  const characterIds = (characters ?? []).map((c) => c.id)

  if (characterIds.length > 0) {
    // Imported lazily so loading the page (and `next build`) never pulls in the
    // ESI/service-role module or runs its top-level client setup.
    const { runAssets } = await import('@/assets.js')
    await runAssets({ characterIds })
  }

  revalidatePath('/character')
}
