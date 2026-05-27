// /character/callback

import { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/utils/supabase/server'

import { sso } from '../sso'

const upsertCharacter =
  (supabase: SupabaseClient) =>
  async (columns: { user_id: string; owner: string; name: string; character_id: number }) => {
    const response = await supabase
      .schema('hangar')
      .from('character')
      .upsert(columns, { onConflict: 'user_id, owner' })
      .select()
    if (response.error) throw new Error(`upsert character failed: ${JSON.stringify(response.error)}`)
    if (!response.data?.[0]?.id) throw new Error(`upsert character returned no row: ${JSON.stringify(response)}`)
    return response.data[0].id
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
    const response = await supabase
      .schema('hangar')
      .from('token')
      .upsert(columns, { onConflict: 'character_id' })
      .select()
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
  const { access_token, refresh_token, ...info } = await sso.exchangeAuthCode(code)
  const {
    decoded_access_token: { name, owner, sub, scp = [], iat, exp },
  } = info
  const issued_at = new Date(iat * 1000).toISOString()
  const expires_at = new Date(exp * 1000).toISOString()
  const eve_character_id = Number(sub.split(':')[2])

  await sso.refreshAccessToken(refresh_token)

  const character_id = await upsertCharacter(supabase)({ user_id, owner, name, character_id: eve_character_id })
  const token_id = await upsertToken(supabase)({
    user_id,
    character_id,
    access_token,
    refresh_token,
    issued_at,
    expires_at,
    scope: [scp].flat(),
  })

  const redirectTo = request.nextUrl.clone()
  redirectTo.pathname = '/character'
  return NextResponse.redirect(redirectTo)
}
