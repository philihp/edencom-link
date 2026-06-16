import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { isChancellor } from './chancellor'
import GrantForm from './grantForm'
import RevokeButton from './revokeButton'

const ChancellorPage = async () => {
  const supabase = await createClient()

  const { data: auth, error } = await supabase.auth.getUser()
  if (error || !auth?.user) {
    redirect('/account/login')
  }

  // Gate: only Chancellors may view this page.
  if (!(await isChancellor(auth.user.id))) {
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
  const ids = [...new Set((rows ?? []).map((r) => r.redeemed_by as string))]

  // Display each Chancellor by their character names; fall back to the account
  // email (then the raw id) for accounts that haven't linked a character yet.
  const { data: regs } = ids.length
    ? await service
        .from('registration')
        .select('user_id, name, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: true })
    : { data: [] }

  const namesByUser = new Map<string, string[]>()
  for (const r of regs ?? []) {
    namesByUser.set(r.user_id, [...(namesByUser.get(r.user_id) ?? []), r.name])
  }

  const emailByUser = new Map<string, string>()
  for (const id of ids) {
    if (namesByUser.has(id)) continue
    const { data } = await service.auth.admin.getUserById(id)
    if (data?.user?.email) emailByUser.set(id, data.user.email)
  }

  const labelFor = (id: string) => namesByUser.get(id)?.join(', ') ?? emailByUser.get(id) ?? id

  return (
    <>
      <h1>Chancellors</h1>
      <p>
        Chancellors can mint <Link href="/account/invite">invite codes</Link> anytime without waiting on the earning
        schedule, and can grant or revoke Chancellor on other accounts.
      </p>

      <h2>Current chancellors</h2>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            {labelFor(id)}
            {id === auth.user.id && ' (you)'} <RevokeButton userId={id} self={id === auth.user.id} />
          </li>
        ))}
      </ul>

      <h2>Make someone a chancellor</h2>
      <p>Enter one of the account&rsquo;s EVE character names. The whole account gains Chancellor powers.</p>
      <GrantForm />
    </>
  )
}

export default ChancellorPage
