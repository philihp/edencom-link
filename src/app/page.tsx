import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import styles from './home.module.css'

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
          Link your characters once and scheduled jobs pull their assets, wallets, orders, blueprints, industry and
          structures out of ESI on your behalf — every change kept as history rather than overwritten. What that buys
          you is the part the client can&rsquo;t do: handing someone exactly one slice of it.
        </p>
      </section>

      <h2 className={styles.heading}>Cut it thinner than the game lets you</h2>
      <dl className={styles.capabilities}>
        <div>
          <dt>Share one ship, not your hangar</dt>
          <dd>
            Mint a public link to a single fitted ship — the fit wheel, its cargo, where it&rsquo;s parked. A buyer or a
            fleetmate opens it without an account and sees that ship and nothing else. Revoke it when the deal closes.
          </dd>
        </div>

        <div>
          <dt>Show dens to one alliance</dt>
          <dd>
            Mercenary den sharing is opt-in per alliance: pick which of yours can see your dens and the hostile-den map
            you&rsquo;ve been keeping. Everyone else — the rest of your corp included, if you want it that way — sees
            nothing.
          </dd>
        </div>

        <div>
          <dt>Hand out a corpse collection</dt>
          <dd>
            Your trophies get a public page of their own, no login on either end, with anything you picked up in the
            last two days badged as new.
          </dd>
        </div>

        <div>
          <dt>Let an assistant ask on your behalf</dt>
          <dd>
            An MCP server at <code>/api/mcp</code>, authorized over OAuth, so Claude can answer &ldquo;which blueprints
            are worth researching&rdquo; or &ldquo;what&rsquo;s sitting in my Jita hangar&rdquo; against exactly the
            data your account can see — never more.
          </dd>
        </div>

        <div>
          <dt>Feed a spreadsheet</dt>
          <dd>
            CSV endpoints built for <code>=IMPORTDATA()</code> and keyed to a personal token, several of which take an{' '}
            <code>at=</code> timestamp — so a sheet can pull last Tuesday&rsquo;s hangar instead of today&rsquo;s.
          </dd>
        </div>

        <div>
          <dt>Ask what changed</dt>
          <dd>
            Assets, orders, jobs and blueprints are versioned, not replaced. &ldquo;When did that stack move?&rdquo; and
            &ldquo;what did I own before downtime?&rdquo; both have answers.
          </dd>
        </div>
      </dl>

      <p className={styles.note}>
        You decide how much to hand over in the first place: adding a character asks EVE for one permission at a time,
        and the features you skip are simply the ones you don&rsquo;t get. Pages then read from that stored copy rather
        than calling ESI live, so everything is stamped with when it landed.{' '}
        {user ? <Link href="/settings/grants">Review your grants</Link> : null}
      </p>

      {user ? (
        <p className={styles.cta}>
          <Link href="/character/">Add or refresh a character</Link> to keep the extracts flowing, or start from{' '}
          <Link href="/asset">your hangars</Link>.
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
