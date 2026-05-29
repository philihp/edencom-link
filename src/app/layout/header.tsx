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
      <Link href="/" className={styles.brand}>
        EVE Hangar
      </Link>
      {!userId && (
        <nav className={styles.nav}>
          <span className={styles.bracket}>[</span>
          <Link href="/account/login">login</Link>
          <span className={styles.sep}>|</span>
          <Link href="/account/register">register</Link>
          <span className={styles.bracket}>]</span>
        </nav>
      )}
      {userId && (
        <nav className={styles.nav}>
          <span className={styles.user}>{userId}</span>
          <span className={styles.bracket}>[</span>
          <Link href="/character/">characters</Link>
          <span className={styles.sep}>|</span>
          <Link href="/market">market</Link>
          <span className={styles.sep}>|</span>
          <Link href="/industry">industry</Link>
          <span className={styles.sep}>|</span>
          <Link href="/structures">structures</Link>
          <span className={styles.sep}>|</span>
          <Link href="/account/settings">settings</Link>
          <span className={styles.bracket}>]</span>
        </nav>
      )}
    </header>
  )
}
export default Header
