import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { needsDurableIdentity } from '../account/lib/ssoEmail'
import { Freshness } from '../Freshness'
import styles from './header.module.css'

const Header = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)

  // Label the signed-in user by their main character, falling back to their
  // earliest one, and to their email if they haven't registered a character yet.
  // Mirrors the inviter lookup on /account/invite.
  let displayName: string | undefined
  let lastRefreshedAt: string | null = null
  if (user) {
    const { data: mainCharacter } = await supabase
      .from('registration')
      .select('name')
      .order('is_main', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    displayName = mainCharacter?.name ?? user.email ?? undefined

    // When this user's ESI data last landed: the most recent completed extract
    // heartbeat attributed to them, whether a scheduled cron pull or an
    // on-demand refresh (both record per-character/per-corp heartbeats).
    const { data: latestBeat } = await supabase
      .from('heartbeat')
      .select('ended_at')
      .eq('user_id', user.id)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastRefreshedAt = latestBeat?.ended_at ?? null
  }

  return (
    <header>
      <div className={styles.bar}>
        <div className={styles.top}>
          <Link href="/" className={styles.brand}>
            Edencom Link
          </Link>
          {/* Plain, not <CharacterName>: the bar is one header line, and a serif
              name sitting beside the sans wordmark set two faces in it. Chrome
              is sans (see the typography note in globals.css). */}
          {displayName && <span className={styles.user}>{displayName}</span>}
          {user && (
            <span className={styles.refresh}>
              <Freshness at={lastRefreshedAt} prefix="Refreshed" never="never refreshed" />
              <span className={styles.bracket}>[</span>
              <Link href="/jobs">refresh</Link>
              <span className={styles.bracket}>]</span>
            </span>
          )}
        </div>
        <nav className={styles.nav}>
          <span className={styles.bracket}>[</span>
          {!user ? (
            <>
              {/* The one page that works signed out, so it needs a way in
                  from here — /asset, where it otherwise lives, is gated. */}
              <Link href="/asset/shipping">shipping</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/login">login</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/register">register</Link>
            </>
          ) : (
            <>
              <Link href="/indexes">indexes</Link>
              <span className={styles.sep}>|</span>
              <Link href="/character/">characters</Link>
              <span className={styles.sep}>|</span>
              <Link href="/asset">assets</Link>
              <span className={styles.sep}>|</span>
              <Link href="/market">market</Link>
              <span className={styles.sep}>|</span>
              <Link href="/industry">industry</Link>
              <span className={styles.sep}>|</span>
              <Link href="/blueprint">blueprint</Link>
              <span className={styles.sep}>|</span>
              <Link href="/fitting">fittings</Link>
              <span className={styles.sep}>|</span>
              <Link href="/structure">structures</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/settings">settings</Link>
            </>
          )}
          <span className={styles.bracket}>]</span>
        </nav>
        {/* An account whose only key is an EVE character has nothing else to
            sign in with: the character token, and the cookies in this browser.
            Say so quietly, once the account is real enough to be worth losing
            (docs/open-registration.md, stage 3). */}
        {user && needsDurableIdentity(user.email) && (
          <p className={styles.nudge}>
            Your characters are the only key to this account.{' '}
            <Link href="/account/email">Add an email and password</Link> so you can sign in from anywhere.
          </p>
        )}
      </div>
    </header>
  )
}
export default Header
