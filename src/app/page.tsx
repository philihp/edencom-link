import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import styles from './home.module.css'

// The tour of the app, shown to everyone: signed-in visitors get working links,
// signed-out ones get the same list as a description of what an account buys.
const FEATURES = [
  { href: '/character/', name: '/characters', blurb: 'Where each pilot is, their clones, implants and jump timer.' },
  { href: '/asset', name: '/asset', blurb: 'Every hangar, container and ship, searchable across all of them.' },
  { href: '/market', name: '/market', blurb: 'Open orders and trade history, character and corporation together.' },
  {
    href: '/industry',
    name: '/industry',
    blurb: 'Jobs in flight, free slots per pilot, and the cost indexes you watch.',
  },
  {
    href: '/blueprint',
    name: '/blueprint',
    blurb: 'Research state, material bills, and which rigs actually bonus a build.',
  },
  {
    href: '/structure',
    name: '/structure',
    blurb: 'Upwell structures with their fuel clocks, services and fitted rigs.',
  },
]

const Home = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <main className={styles.wrap}>
      <section className={styles.welcome}>
        <p className={styles.title}>
          <span className={styles.spark}>✻</span>
          Welcome to Edencom Link
        </p>
        <p className={styles.lede}>
          A quiet ledger for your corner of New Eden. Link your characters once and scheduled jobs pull their assets,
          wallets, orders, blueprints, industry and structures out of ESI for you — keeping every change as history, so
          you can see not just what you have, but what changed while you were docked.
        </p>
      </section>

      <ul className={styles.features}>
        {FEATURES.map(({ href, name, blurb }) => (
          <li key={href} className={styles.feature}>
            {user ? (
              <Link href={href} className={styles.name}>
                {name}
              </Link>
            ) : (
              <span className={styles.name}>{name}</span>
            )}
            <span className={styles.blurb}>{blurb}</span>
          </li>
        ))}
      </ul>

      <p className={styles.note}>
        Pages read from the database rather than calling ESI live, so everything is dated and nothing rate-limits you.
        The same data leaves by three other doors: CSV endpoints for Google Sheets, share links for a single ship or
        hangar, and an MCP server your AI assistant can query directly.
      </p>

      {user ? (
        <p className={styles.cta}>
          <Link href="/character/">Add or refresh a character</Link> to keep the extracts flowing.
        </p>
      ) : (
        <p className={styles.cta}>
          <Link href="/account/login">Log in</Link> to pick up where you left off, or{' '}
          <Link href="/account/register">register</Link> with an invite code — this is a small, invite-only outfit.
        </p>
      )}
    </main>
  )
}

export default Home
