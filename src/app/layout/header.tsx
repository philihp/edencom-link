import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import { indexesFlag } from '@/flags'
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
  if (user) {
    const { data: mainCharacter } = await supabase
      .from('registration')
      .select('name')
      .order('is_main', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    displayName = mainCharacter?.name ?? user.email ?? undefined
  }

  const showIndexes = await indexesFlag()
  return (
    <header>
      <div className={styles.bar}>
        <div className={styles.top}>
          <Link href="/" className={styles.brand}>
            Edencom Link
          </Link>
          {displayName && <span className={styles.user}>{displayName}</span>}
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
              {showIndexes && (
                <>
                  <Link href="/indexes">indexes</Link>
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
