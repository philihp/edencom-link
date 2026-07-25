import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import styles from './home.module.css'

// The capability pitch: each card names something the game client can't do,
// because it can't hold history or hand out a slice of your account.
const CAPABILITIES = [
  {
    label: 'Sharing',
    title: 'Share one ship, not your hangar',
    body: 'Mint a public link to a single fitted ship — the fit wheel, its cargo, where it is parked. A buyer or a fleetmate opens it without an account, sees that ship and nothing else, and the link dies when you revoke it.',
  },
  {
    label: 'Intel',
    title: 'Show dens to one alliance',
    body: 'Mercenary den sharing is opt-in per alliance. Pick which of yours can see your dens and the hostile-den map you keep — everyone else, corpmates included, sees nothing.',
  },
  {
    label: 'Public pages',
    title: 'Hand out a corpse collection',
    body: 'Your trophies get a page of their own that needs no login on either end, with anything you picked up in the last two days badged as new.',
  },
  {
    label: 'MCP',
    title: 'Let an assistant answer for you',
    body: 'An OAuth-authorized MCP server, so Claude can field “which blueprints are worth researching” or “what is sitting in my Jita hangar” against exactly the data your account can see — never more.',
  },
  {
    label: 'Exports',
    title: 'Feed a spreadsheet',
    body: 'CSV endpoints built for =IMPORTDATA() and keyed to a personal token, several of which take an at= timestamp — so a sheet can pull last Tuesday’s hangar instead of today’s.',
  },
  {
    label: 'History',
    title: 'Ask what changed',
    body: 'Assets, orders, jobs and blueprints are versioned rather than replaced. “When did that stack move?” and “what did I own before downtime?” both have answers.',
  },
]

const STEPS = [
  {
    title: 'Link a character',
    body: 'EVE SSO asks for one permission at a time. Grant what you want; the features you skip are simply the ones you do not get.',
  },
  {
    title: 'Let the extracts run',
    body: 'Scheduled jobs pull each endpoint into storage and keep every version. Nothing here writes to your account, ever.',
  },
  {
    title: 'Read it, slice it, query it',
    body: 'Browse the pages, hand out a link to exactly one thing, pipe it into Sheets, or point an AI assistant at it.',
  },
]

const Home = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>
          <span className={styles.spark}>✻</span>
          EVE Online · assets, industry &amp; intel
        </p>
        <h1 className={styles.headline}>Your empire, extracted — and sliceable.</h1>
        <p className={styles.sub}>
          Edencom Link keeps a versioned copy of what your characters and corporations own, earn, build and hold space
          with. Then it lets you hand out exactly one piece of it — a single ship, one alliance&rsquo;s worth of den
          intel, a spreadsheet, an AI assistant&rsquo;s question — without opening the rest.
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/asset" className={styles.primary}>
                Open your hangars
              </Link>
              <Link href="/character/" className={styles.secondary}>
                Add a character
              </Link>
            </>
          ) : (
            <>
              <Link href="/account/register" className={styles.primary}>
                Redeem an invite
              </Link>
              <Link href="/account/login" className={styles.secondary}>
                Log in
              </Link>
            </>
          )}
        </div>
        <p className={styles.microcopy}>Invite-only · read-only ESI access · you choose the scopes</p>
      </section>

      <section className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>18</span>
          <span className={styles.statLabel}>scheduled extracts keeping your copy current</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>6h</span>
          <span className={styles.statLabel}>between passes, or refresh any of them on demand</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>0</span>
          <span className={styles.statLabel}>writes back to your account — it only ever reads</span>
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>Capabilities</p>
        <h2 className={styles.sectionTitle}>Cut it thinner than the game lets you</h2>
        <div className={styles.cards}>
          {CAPABILITIES.map(({ label, title, body }) => (
            <article key={title} className={styles.card}>
              <p className={styles.cardLabel}>{label}</p>
              <h3 className={styles.cardTitle}>{title}</h3>
              <p className={styles.cardBody}>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>How it works</p>
        <h2 className={styles.sectionTitle}>Three steps, then it runs itself</h2>
        <ol className={styles.steps}>
          {STEPS.map(({ title, body }, index) => (
            <li key={title} className={styles.step}>
              <span className={styles.stepNumber}>{index + 1}</span>
              <div>
                <p className={styles.stepTitle}>{title}</p>
                <p className={styles.stepBody}>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>
          {user ? 'Everything is where you left it.' : 'Bring your own invite code.'}
        </h2>
        <p className={styles.closingBody}>
          {user
            ? 'Your extracts are running. Check what landed recently, or grant a scope you skipped the first time.'
            : 'This is a small outfit, so accounts are handed out by invite. If you have a code, it takes about a minute to link your first character.'}
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/character/refresh" className={styles.primary}>
                See what is fresh
              </Link>
              <Link href="/settings/grants" className={styles.secondary}>
                Review your grants
              </Link>
            </>
          ) : (
            <>
              <Link href="/account/register" className={styles.primary}>
                Redeem an invite
              </Link>
              <Link href="/account/login" className={styles.secondary}>
                Log in
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

export default Home
