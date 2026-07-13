import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import { corpsesFlag, mercenaryDensFlag } from '@/flags'
import { Freshness } from '../Freshness'
import styles from './header.module.css'

const Header = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Label the signed-in user by their main character, falling back to their
  // earliest one, and to their email if they haven't registered a character yet.
  // Mirrors the inviter lookup on /account/invite.
  let displayName: string | undefined
  let mainCharacterId: number | string | null = null
  let lastRefreshedAt: string | null = null
  if (user) {
    const { data: mainCharacter } = await supabase
      .from('registration')
      .select('name, character_id')
      .order('is_main', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    displayName = mainCharacter?.name ?? user.email ?? undefined
    // The corpses share page is keyed on a character id; link the signed-in
    // user to their own (their main character's).
    mainCharacterId = mainCharacter?.character_id ?? null

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

  const [showMercenaryDens, showCorpses] = await Promise.all([mercenaryDensFlag(), corpsesFlag()])
  return (
    <header>
      <div className={styles.bar}>
        <div className={styles.top}>
          <Link href="/" className={styles.brand}>
            Edencom Link
          </Link>
          {displayName && <span className={styles.user}>{displayName}</span>}
          {user && (
            <span className={styles.refresh}>
              <Freshness at={lastRefreshedAt} prefix="Refreshed" never="never refreshed" />
              <span className={styles.bracket}>[</span>
              <Link href="/character/refresh">refresh</Link>
              <span className={styles.bracket}>]</span>
            </span>
          )}
        </div>
        <nav className={styles.nav}>
          <span className={styles.bracket}>[</span>
          {!user ? (
            <>
              <Link href="/account/login">login</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/register">register</Link>
            </>
          ) : (
            <>
              <Link href="/indexes">indexes</Link>
              <span className={styles.sep}>|</span>
              {showMercenaryDens && (
                <>
                  <Link href="/mercenary-dens">mercenary&nbsp;dens</Link>
                  <span className={styles.sep}>|</span>
                </>
              )}
              {showCorpses && mainCharacterId != null && (
                <>
                  <Link href={`/corpses/${mainCharacterId}`}>corpses</Link>
                  <span className={styles.sep}>|</span>
                </>
              )}
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
              <Link href="/structure">structures</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/settings">settings</Link>
            </>
          )}
          <span className={styles.bracket}>]</span>
        </nav>
      </div>
    </header>
  )
}
export default Header
