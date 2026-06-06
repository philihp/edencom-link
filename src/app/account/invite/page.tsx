import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { DateTime } from '../../DateTime'
import CreateButton from './createButton'
import { earnedCount, unlockDate, weeksToUnlock } from './schedule'

const InvitesPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  // When the clock started: the first character this user added via SSO. RLS
  // scopes both of these queries to the signed-in user.
  const { data: firstChar } = await supabase
    .from('registration')
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const firstSsoAt = firstChar?.created_at ? new Date(firstChar.created_at) : null

  const { data: codes } = await supabase
    .from('invite_code')
    .select('code, redeemed_by')
    .order('created_at', { ascending: true })

  const allCodes = codes ?? []
  const unused = allCodes.filter((c) => !c.redeemed_by)
  const earned = earnedCount(firstSsoAt)
  const available = Math.max(0, earned - allCodes.length)

  // Show the schedule a couple of rows past whatever has been unlocked so far.
  const scheduleLength = Math.max(earned + 2, 5)

  return (
    <>
      <h1>Invite codes</h1>
      <p>
        Edencom Link is invite-only. Share an unused code below with someone to let them register an account — each code
        works once.
      </p>

      {!firstSsoAt && (
        <p>
          The clock hasn&rsquo;t started yet. Your first invite code unlocks a week after you{' '}
          <Link href="/character">add a character</Link> through EVE SSO.
        </p>
      )}

      <h2>Codes to give out</h2>
      {unused.length > 0 ? (
        <ul>
          {unused.map((c) => (
            <li key={c.code}>
              <code>{c.code}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no unused invite codes right now.</p>
      )}

      {available > 0 && <CreateButton available={available} />}

      <h2>Schedule</h2>
      {firstSsoAt ? (
        <p>
          Counting from your first character on <DateTime value={firstSsoAt} />, you&rsquo;ve unlocked {earned} invite{' '}
          {earned === 1 ? 'code' : 'codes'} so far. Each one takes twice as long to earn as the last.
        </p>
      ) : (
        <p>Each invite code takes twice as long to earn as the last:</p>
      )}
      <table>
        <thead>
          <tr>
            <th>Invite</th>
            <th>Unlocks after</th>
            {firstSsoAt && <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: scheduleLength }, (_, i) => i + 1).map((n) => {
            const weeks = weeksToUnlock(n)
            const unlocked = n <= earned
            return (
              <tr key={n}>
                <td>#{n}</td>
                <td>
                  {weeks} {weeks === 1 ? 'week' : 'weeks'}
                </td>
                {firstSsoAt && <td>{unlocked ? 'unlocked' : <DateTime value={unlockDate(firstSsoAt, n)} />}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

export default InvitesPage
