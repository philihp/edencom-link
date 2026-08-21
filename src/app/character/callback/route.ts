// /character/callback

import { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

import { character } from '@/esi'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { mintSession } from '../../account/lib/mintSession'
import { characterCallbackPlan } from '../../account/lib/signupFlow'
import { eveEmail } from '../../account/lib/ssoEmail'
import { dispatchRefresh } from '../dispatchRefresh'
import { sso } from '../sso'

const upsertCharacter =
  (supabase: SupabaseClient) =>
  async (columns: { user_id: string; owner: string; name: string; character_id: number; corporation_id?: number }) => {
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

  const { error: updateError } = await supabase
    .from('registration')
    .update({ is_main: true })
    .eq('id', oldest.id)
    .eq('user_id', user_id)
  if (updateError) throw new Error(`mark main character failed: ${JSON.stringify(updateError)}`)
}

const upsertToken =
  (supabase: SupabaseClient) =>
  async (columns: {
    user_id: string
    registration_id: string
    access_token: string
    refresh_token: string
    issued_at: string
    expires_at: string
    scope: string[]
  }) => {
    // No .select(): the caller never used the id, and not reading the row back
    // keeps the refresh_token out of this process's memory a moment longer.
    const response = await supabase.from('token').upsert(columns, { onConflict: 'registration_id' })
    if (response.error) throw new Error(`upsert token failed: ${JSON.stringify(response.error)}`)
  }

// Give an account with no address of its own the EVE placeholder, so it can be
// signed into later. An account that grew out of an anonymous session has no
// email, and mintSession's magic-link token is keyed on one — without this, an
// account whose only identity is a character could never be recovered from a
// browser that lost its cookies. Confirmed on the spot: the domain receives no
// mail, so there is nobody to confirm it. Best-effort — a failure here must not
// cost the player the character they just authorized.
const ensureRecoveryEmail = async (service: SupabaseClient, userId: string, eveCharacterId: number) => {
  const { data, error } = await service.auth.admin.getUserById(userId)
  if (error || !data?.user || data.user.email) return
  const { error: updateError } = await service.auth.admin.updateUserById(userId, {
    email: eveEmail(eveCharacterId),
    email_confirm: true,
  })
  if (updateError) console.warn(`/character/callback: placeholder email for ${userId} failed: ${updateError.message}`)
}

export const GET = async (request: NextRequest) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('no authenticated supabase user on /character/callback')
  // Not const: the SSO exchange below can reveal that this character already
  // belongs to another account, and the writes then land on that one.
  let user_id = user.id

  // registration and token are service-role-only at the grant layer, and this
  // route is their sole writer. The reason is that registration.character_id is
  // an authorization input — every corp_* policy and
  // my_corporation_ids()/my_alliance_ids() trust it — but a user-session write
  // is indistinguishable from a hand-crafted POST claiming someone else's
  // character. What separates them is the EVE SSO code exchange below, whose
  // RS256 signature @philihp/eve-sso verifies against CCP's JWKS. That check
  // can only happen here: no Postgres extension on this project can verify
  // RS256 (pgjwt is HMAC-only, pgcrypto and pgsodium have no RSA verify), so
  // the database cannot be handed the proof and left to police itself.
  //
  // Service-role clients bypass RLS, so treat this as a deliberate exception,
  // not a pattern to copy: every write below is scoped to user_id by hand, and
  // nothing here reads on the caller's behalf. Prefer the session client
  // (`supabase`) anywhere the caller's own RLS scope is sufficient.
  const service = createServiceClient()

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
  // character-directory run. Best-effort: a transient ESI failure just leaves
  // it unset (that job backfills it), so it never blocks registration. Only
  // written when resolved, so a failed re-auth can't null out a known corp.
  let corporation_id: number | undefined
  try {
    const sheet = await character(access_token, eve_character_id)
    if (sheet?.corporation_id != null) corporation_id = Number(sheet.corporation_id)
  } catch (e) {
    console.warn(`/character/callback: corp lookup failed for ${eve_character_id}: ${(e as Error)?.message}`)
  }

  // Whose account does this character belong on? `(character_id, owner)` is
  // EVE's own "same character, same player" pair — CCP rolls `owner` on a
  // transfer — so a match means the returning player is who they were, and a
  // caller who is still a drive-by (anonymous, owning nothing) is signed into
  // that account instead of starting a second one holding the same character.
  // This is at once the "Log in with EVE Online" path and the recovery path for
  // an account whose browser lost its cookies.
  const { data: existingOwner } = await service
    .from('registration')
    .select('user_id')
    .eq('character_id', eve_character_id)
    .eq('owner', owner)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const { count: callerRegistrations } = await service
    .from('registration')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)

  const plan = characterCallbackPlan({
    caller: {
      userId: user.id,
      isAnonymous: user.is_anonymous === true,
      hasRegistration: (callerRegistrations ?? 0) > 0,
    },
    existingOwnerUserId: existingOwner?.user_id ?? null,
  })

  if (plan === 'sign-in-existing') {
    // Backfills the placeholder first, for accounts that predate it — the
    // magic-link token below is keyed on an address.
    await ensureRecoveryEmail(service, existingOwner!.user_id, eve_character_id)
    const error = await mintSession(existingOwner!.user_id)
    if (error) throw new Error(`signing in to the account holding ${name} failed: ${error}`)
    user_id = existingOwner!.user_id
  } else {
    await ensureRecoveryEmail(service, user_id, eve_character_id)
  }

  // upsertCharacter returns registration.id — a uuid — not an EVE id. The
  // `character_id` column it writes is registration's own, which really is the
  // EVE numeric id.
  const registration_id = await upsertCharacter(service)({
    user_id,
    owner,
    name,
    character_id: eve_character_id,
    ...(corporation_id != null ? { corporation_id } : {}),
  })
  await ensureMainCharacter(service)(user_id)
  await upsertToken(service)({
    user_id,
    registration_id,
    access_token,
    refresh_token,
    issued_at,
    expires_at,
    scope: [scp].flat(),
  })

  // Pull this character's ESI data right away so it's populated by the time the
  // user looks, and drop them on the refresh page to watch it land (it shows
  // the just-dispatched tasks without needing the batch id).
  await dispatchRefresh(user_id, [{ id: registration_id, name }])

  const redirectTo = request.nextUrl.clone()
  redirectTo.pathname = '/jobs'
  redirectTo.search = ''
  return NextResponse.redirect(redirectTo)
}
