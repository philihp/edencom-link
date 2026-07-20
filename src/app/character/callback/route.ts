// /character/callback

import { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

import { character } from '@/esi'
import { createClient } from '@/utils/supabase/server'

import { dispatchRefresh } from '../dispatchRefresh'
import { sso } from '../sso'

const upsertCharacter =
  (supabase: SupabaseClient) =>
  async (columns: {
    user_id: string
    owner: string
    name: string
    character_id: number
    corporation_id?: number
  }) => {
    const response = await supabase.from('registration').upsert(columns, { onConflict: 'user_id, owner' }).select()
    if (response.error) throw new Error(`upsert character failed: ${JSON.stringify(response.error)}`)
    if (!response.data?.[0]?.id) throw new Error(`upsert character returned no row: ${JSON.stringify(response)}`)
    return response.data[0].id
  }

// If the user has no registration marked main yet, mark their oldest one. Runs
// after upsertCharacter, so a brand new player's first (and only) registration
// qualifies as "oldest" and becomes main immediately.
const ensureMainCharacter = (supabase: SupabaseClient) => async (user_id: string) => {
  const { count, error: countError } = await supabase
    .from('registration')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user_id)
    .eq('is_main', true)
  if (countError) throw new Error(`main character lookup failed: ${JSON.stringify(countError)}`)
  if (count) return

  const { data: oldest, error: oldestError } = await supabase
    .from('registration')
    .select('id')
    .eq('user_id', user_id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (oldestError) throw new Error(`oldest registration lookup failed: ${JSON.stringify(oldestError)}`)
  if (!oldest?.id) return

  const { error: updateError } = await supabase.from('registration').update({ is_main: true }).eq('id', oldest.id)
  if (updateError) throw new Error(`mark main character failed: ${JSON.stringify(updateError)}`)
}

const upsertToken =
  (supabase: SupabaseClient) =>
  async (columns: {
    user_id: string
    character_id: string
    access_token: string
    refresh_token: string
    issued_at: string
    expires_at: string
    scope: string[]
  }) => {
    const response = await supabase.from('token').upsert(columns, { onConflict: 'character_id' }).select()
    if (response.error) throw new Error(`upsert token failed: ${JSON.stringify(response.error)}`)
    if (!response.data?.[0]?.id) throw new Error(`upsert token returned no row: ${JSON.stringify(response)}`)
    return response.data[0].id
  }

export const GET = async (request: NextRequest) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('no authenticated supabase user on /character/callback')
  const user_id = user.id

  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  if (!code) throw new Error('no code on /character/callback')
  const { access_token, refresh_token, ...info } = await sso.getAccessToken(code)
  const { name, owner, sub, scp = [], exp } = info.decoded_access_token
  const { iat } = info.decoded_access_token as unknown as { iat: number }
  const issued_at = new Date(iat * 1000).toISOString()
  const expires_at = new Date(exp * 1000).toISOString()
  const eve_character_id = Number(sub.split(':')[2])
  await sso.getAccessToken(refresh_token, true)

  // Resolve the character's corporation up front so registration.corporation_id
  // is populated immediately, instead of only after the first
  // character-affiliations run. Best-effort: a transient ESI failure just leaves
  // it unset (that job backfills it), so it never blocks registration. Only
  // written when resolved, so a failed re-auth can't null out a known corp.
  let corporation_id: number | undefined
  try {
    const sheet = await character(access_token, eve_character_id)
    if (sheet?.corporation_id != null) corporation_id = Number(sheet.corporation_id)
  } catch (e) {
    console.warn(`/character/callback: corp lookup failed for ${eve_character_id}: ${(e as Error)?.message}`)
  }

  const character_id = await upsertCharacter(supabase)({
    user_id,
    owner,
    name,
    character_id: eve_character_id,
    ...(corporation_id != null ? { corporation_id } : {}),
  })
  await ensureMainCharacter(supabase)(user_id)
  await upsertToken(supabase)({
    user_id,
    character_id,
    access_token,
    refresh_token,
    issued_at,
    expires_at,
    scope: [scp].flat(),
  })

  // Pull this character's ESI data right away so it's populated by the time the
  // user looks, and drop them on the refresh page to watch it land (it shows
  // the just-dispatched tasks without needing the batch id).
  await dispatchRefresh(user_id, [{ id: character_id, name }])

  const redirectTo = request.nextUrl.clone()
  redirectTo.pathname = '/character/refresh'
  redirectTo.search = ''
  return NextResponse.redirect(redirectTo)
}
