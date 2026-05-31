import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import styles from './header.module.css'

const Header = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const userId = user?.email ?? undefined
  return (
    <header>
      <div className={styles.bar}>
        <div className={styles.top}>
          <Link href="/" className={styles.brand}>
            Edencom Link
          </Link>
          {userId && <span className={styles.user}>{userId}</span>}
        </div>
        <nav className={styles.nav}>
          <span className={styles.bracket}>[</span>
          {!userId ? (
            <>
              <Link href="/account/login">login</Link>
              <span className={styles.sep}>|</span>
              <Link href="/account/register">register</Link>
            </>
          ) : (
            <>
              <Link href="/character/">characters</Link>
              <span className={styles.sep}>|</span>
              <Link href="/market">market</Link>
              <span className={styles.sep}>|</span>
              <Link href="/industry">industry</Link>
              <span className={styles.sep}>|</span>
              <Link href="/structures">structures</Link>
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
