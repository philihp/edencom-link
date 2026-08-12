import Link from 'next/link'
import { redirect } from 'next/navigation'
import { pluck, reduce, uniq } from 'ramda'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../lib/establishedUser'

import { isChancellor } from './chancellor'
import FlagForm from './flagForm'
import GrantForm from './grantForm'
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
    </>
  )
}

export default ChancellorPage
