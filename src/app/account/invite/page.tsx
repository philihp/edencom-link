import Link from 'next/link'
import { redirect } from 'next/navigation'
import { pluck, uniq } from 'ramda'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { DateTime } from '../../DateTime'
import { isChancellor } from '../chancellor/chancellor'
import { mainCharacterNameForUser, mainCharacterNamesForUsers } from '../lib/inviter'
import CopyLink from './copyLink'
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

  // The codes this user has created. RLS scopes invite_code reads to created_by =
  // the signed-in user, so this is exactly their own codes.
  const { data: codes } = await supabase
    .from('invite_code')
    .select('code, redeemed_by, redeemed_at, created_at')
    .order('created_at', { ascending: true })

  const chancellor = await isChancellor(data.user.id)

  // Who invited this account: the code they redeemed names its creator. The user
  // can't read that row under RLS (it's the inviter's code), and the inviter's
  // characters live behind their own RLS too, so both lookups use the service
  // role. `created_by` is null for the founding/seed codes. The inviter is shown
  // by their main character, falling back to their earliest one.
  const service = createServiceClient()
  const { data: redeemedCode } = await service
    .from('invite_code')
    .select('created_by')
    .eq('redeemed_by', data.user.id)
    .maybeSingle()
  const inviterName = redeemedCode?.created_by ? await mainCharacterNameForUser(redeemedCode.created_by) : null

  const allCodes = codes ?? []
  const unused = allCodes.filter((c) => !c.redeemed_by)

  // Who claimed each redeemed code, by their main character. The redeemer's
  // registrations sit behind their own RLS, so this reuses the same service-role
  // lookup as the inviter line above, batched across every claimed code.
  const claimedNames = await mainCharacterNamesForUsers(
    uniq(
      pluck(
        'redeemed_by',
        allCodes.filter((c) => c.redeemed_by)
      ) as string[]
    )
  )
  const earned = earnedCount(firstSsoAt)
  const available = Math.max(0, earned - allCodes.length)

  // Show the schedule a couple of rows past whatever has been unlocked so far.
  const scheduleLength = Math.max(earned + 2, 5)

  return (
    <>
      <h1>Invite codes</h1>
      <p>
        Edencom Link is invite-only. Copy an unused code&rsquo;s link below and send it to someone to let them register
        an account — each code works once.
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
              <CopyLink code={c.code} />
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no unused invite codes right now.</p>
      )}

      {chancellor ? (
        <>
          <p>As a Chancellor, you can create invite codes anytime — you aren&rsquo;t limited by the schedule below.</p>
          <CreateButton unlimited />
        </>
      ) : (
        available > 0 && <CreateButton available={available} />
      )}

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

      {redeemedCode && (
        <>
          <h2>Who invited you</h2>
          {inviterName ? (
            <p>You were invited by {inviterName}.</p>
          ) : redeemedCode.created_by ? (
            <p>You were invited by another capsuleer.</p>
          ) : (
            <p>You joined with a founding invite code.</p>
          )}
        </>
      )}

      {allCodes.length > 0 && (
        <>
          <h2>Codes you&rsquo;ve created</h2>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Created</th>
                <th>Status</th>
                <th>Claimed by</th>
              </tr>
            </thead>
            <tbody>
              {allCodes.map((c) => (
                <tr key={c.code}>
                  <td>{c.redeemed_by ? <code>{c.code}</code> : <CopyLink code={c.code} />}</td>
                  <td>{c.created_at ? <DateTime value={new Date(c.created_at)} /> : '—'}</td>
                  <td>
                    {c.redeemed_by ? (
                      c.redeemed_at ? (
                        <>
                          Claimed <DateTime value={new Date(c.redeemed_at)} />
                        </>
                      ) : (
                        'Claimed'
                      )
                    ) : (
                      'Unclaimed'
                    )}
                  </td>
                  <td>{(c.redeemed_by && claimedNames.get(c.redeemed_by)) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}

export default InvitesPage
