import Link from 'next/link'
import { redirect } from 'next/navigation'
import { pluck, reduce, uniq } from 'ramda'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../lib/establishedUser'

import { isChancellor } from './chancellor'
import FlagForm from './flagForm'
import GrantForm from './grantForm'
import ImpersonateForm from './impersonateForm'
import RevokeButton from './revokeButton'

const ChancellorPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  // Gate: only Chancellors may view this page.
  if (!(await isChancellor(user.id))) {
    redirect('/account/settings')
  }

  // List every Chancellor: the accounts that redeemed a chancellor-flagged code.
  // invite_code is only readable per-row under RLS, so this cross-account read
  // uses the service role.
  const service = createServiceClient()
  const { data: rows } = await service
    .from('invite_code')
    .select('redeemed_by')
    .eq('is_chancellor', true)
    .not('redeemed_by', 'is', null)
  const ids = uniq(pluck('redeemed_by', rows ?? []) as string[])

  // Display each Chancellor by their character names; fall back to the account
  // email (then the raw id) for accounts that haven't linked a character yet.
  const { data: regs } = ids.length
    ? await service
        .from('registration')
        .select('user_id, name, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: true })
    : { data: [] }

  const namesByUser = reduce(
    (acc, r) => acc.set(r.user_id, [...(acc.get(r.user_id) ?? []), r.name]),
    new Map<string, string[]>(),
    regs ?? []
  )

  const emailByUser = new Map<string, string>()
  for (const id of ids) {
    if (namesByUser.has(id)) continue
    const { data } = await service.auth.admin.getUserById(id)
    if (data?.user?.email) emailByUser.set(id, data.user.email)
  }

  const labelFor = (id: string) => namesByUser.get(id)?.join(', ') ?? emailByUser.get(id) ?? id

  // The caller's own account, raw — moved here from the old /account/debug page.
  const { data: settings } = await supabase
    .from('user_settings')
    .select('enabled_scopes, api_token, flags, updated_at')
    .eq('user_id', user.id)
    .maybeSingle()

  // created_at/last_sign_in_at are profile fields, not access-token claims, so
  // establishedUser() cannot supply them. This page already holds a
  // service-role client and reads other accounts through it the same way; one
  // more lookup for the caller's own record is in keeping, and this is a
  // Chancellor-only page where an extra Auth call costs nothing anyone notices.
  const { data: profile } = await service.auth.admin.getUserById(user.id)

  const debugInfo = {
    user_id: user.id,
    email: user.email,
    created_at: profile?.user?.created_at ?? null,
    last_sign_in_at: profile?.user?.last_sign_in_at ?? null,
    enabled_scopes: settings?.enabled_scopes ?? [],
    api_token: settings?.api_token ?? null,
    flags: settings?.flags ?? [],
    settings_updated_at: settings?.updated_at ?? null,
  }

  return (
    <>
      <Link href="/account/settings">&laquo; Back to settings</Link>

      <h1>Chancellor</h1>
      <p>
        Chancellors can mint <Link href="/account/invite">invite codes</Link> anytime without waiting on the earning
        schedule, can grant or revoke Chancellor on other accounts, and can set any account&rsquo;s feature flags.
      </p>

      <h2>Current chancellors</h2>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            {labelFor(id)}
            {id === user.id && ' (you)'} <RevokeButton userId={id} self={id === user.id} />
          </li>
        ))}
      </ul>

      <h2>Make someone a chancellor</h2>
      <p>Enter one of the account&rsquo;s EVE character names. The whole account gains Chancellor powers.</p>
      <GrantForm />

      <h2>Feature flags</h2>
      <p>
        Turn a dark-launched feature on or off for one account. Load an account by one of its EVE character names, then
        tick what it should have — saving replaces its whole flag list.
      </p>
      <FlagForm />

      <h2>Impersonate</h2>
      <p>Swaps this session for a real session as another account. Sign back in as yourself to return.</p>
      <ImpersonateForm />

      <h2>Debug</h2>
      <p>Your own account, as the database sees it.</p>
      <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
    </>
  )
}

export default ChancellorPage
