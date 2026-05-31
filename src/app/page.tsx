import Link from 'next/link'
import styles from './home.module.css'

export default function Home() {
  return (
    <main className={styles.wrap}>
      <section className={styles.welcome}>
        <p className={styles.title}>
          <span className={styles.spark}>✻</span>
          Welcome to Edencom Link
        </p>
        <p className={styles.tip}>
          Your market, industry, and structure data — tracked from ESI and
          ready to read.
        </p>
      </section>

      <div className={styles.prompt}>
        <span className={styles.caret}>&gt;</span>
        <span>where to next?</span>
      </div>

      <nav className={styles.hints}>
        <Link href="/character/">/characters</Link>
        <Link href="/market">/market</Link>
        <Link href="/industry">/industry</Link>
        <Link href="/structures">/structures</Link>
        <Link href="/account/settings">/settings</Link>
      </nav>
    </main>
  )
}
