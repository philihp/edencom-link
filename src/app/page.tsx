import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from './account/lib/establishedUser'
import styles from './home.module.css'

// The lore is the frame, not the labels. Anything that exists in the EVE client
// keeps its client name here — a player scanning these cards should recognise
// every one of them without translating. The flavour lives in the prose below.
const SECTIONS = [
  {
    label: 'Wallet',
    title: 'Wallet & Journal',
    body: 'Every character\u2019s wallet in one ledger, next to your corporation\u2019s division wallets. Journal entries roll up by reference type, so you can see what the ISK actually was \u2014 bounties, taxes, escrow \u2014 instead of scrolling a thousand lines.',
  },
  {
    label: 'Inventory',
    title: 'Assets & Inventory',
    body: 'Every item in every station, ship, and nested container, searchable, with stack counts and location drill-down. Nothing is overwritten, so \u201cwhat did I hold before that downtime\u201d is a question with an answer.',
  },
  {
    label: 'Industry',
    title: 'Manufacturing & Research',
    body: 'Industry jobs, blueprints with their ME and TE levels, and job slots counted from what your characters have actually trained. System cost indices and the rigs fitted to your structures are part of the same picture.',
  },
  {
    label: 'Market',
    title: 'Market Orders',
    body: 'Open orders and full transaction history, across characters and corp divisions. What filled, what expired, and what it cleared at \u2014 without logging in eleven times to find out.',
  },
  {
    label: 'Structures',
    title: 'Structures & Fuel',
    body: 'Fuel runway, service modules, fitted rigs, and reinforcement state for every Upwell structure. Industry-tax revenue is broken out per structure per day, so you know which citadel is earning its fuel blocks.',
  },
  {
    label: 'Clones',
    title: 'Clones & Implants',
    body: 'Jump clones and where they\u2019re parked, implant loadouts, and jump-timer availability, across every character. Skill training history rides along, so who trained what, and when, is on record.',
  },
  {
    label: 'Mercenary dens',
    title: 'Mercenary Den Operations',
    body: 'Your dens with development and anarchy levels, reinforcement timers, and a map of what sits around them. Intel sharing is opt-in and scoped to exactly one alliance \u2014 no further.',
  },
  {
    label: 'Analytics',
    title: 'Analytics & Exports',
    body: 'CSV feeds built for Google Sheets =IMPORTDATA(), keyed to a personal token. The asset, order, industry and blueprint feeds each answer for a past date, so your spreadsheet time-travels with the database.',
  },
  {
    label: 'Blueprints',
    title: 'Blueprint Calculator',
    body: 'Name an item; it resolves the blueprint that builds it and prices the material bill against runs, ME, your structure\u2019s role bonus, its fitted ME rig, and system security \u2014 a rig counts only where it actually covers that product. You reach it by asking an AI assistant in plain language, over an OAuth-authorized MCP server scoped to exactly your own data.',
  },
]

// EDENCOM's actual innovation was never the Vorton projector. It was getting
// four states that had been shooting at each other to trust one feed — which
// took a doctrine about what the feed may and may not do.
const DOCTRINE = [
  {
    title: 'Nothing is overwritten',
    body: 'Every asset, order, job, and blueprint is versioned: a change closes the old row and opens a new one. \u201cWhen did that stack move?\u201d is a query, not an argument.',
  },
  {
    title: 'Compartmented by construction',
    body: 'Row-level security scopes every read to your own account, and access is granted one ESI scope at a time. Shares are deliberately narrow: one ship, one alliance\u2019s intel, one public page.',
  },
  {
    title: 'Read-only, structurally',
    body: 'The site holds no write permission against your account and never asks for one. It can tell you what you own; it cannot touch it. It is a receiver, not a transmitter.',
  },
]

const STEPS = [
  {
    title: 'Link a character',
    body: 'Sign in through EVE SSO and grant scopes one at a time. Anything you skip simply stays dark \u2014 the site works with whatever you choose to feed it.',
  },
  {
    title: 'Let the pipelines run',
    body: 'Scheduled jobs pull every endpoint on their own clock and keep every version. Backfill is automatic; there is nothing to import, export, or paste by hand.',
  },
  {
    title: 'Read the picture',
    body: 'Browse it, wire a spreadsheet to a CSV feed, hand out a share link scoped to exactly one thing, or point an AI assistant at your data and start asking questions.',
  },
]

const Home = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>
          <span className={styles.spark}>✻</span>
          Standing datalink · New Eden
        </p>
        <h1 className={styles.headline}>One picture. Every hangar, every wallet, every alt.</h1>
        <p className={styles.sub}>
          EDENCOM’s real achievement was never the Vorton projector. It was getting four empires that had spent a
          millennium shooting at each other to read one threat picture and trust it. Your eleven alts have the same
          problem. This is their datalink.
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/asset" className={styles.primary}>
                Open your assets
              </Link>
              <Link href="/character/" className={styles.secondary}>
                Add a character
              </Link>
            </>
          ) : (
            <>
              <Link href="/account/register" className={styles.primary}>
                Request access
              </Link>
              <Link href="/account/login" className={styles.secondary}>
                Sign in
              </Link>
            </>
          )}
        </div>
        <p className={styles.microcopy}>Invite-only · read-only ESI access · you choose the scopes</p>
      </section>

      <section className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>23</span>
          <span className={styles.statLabel}>scheduled extraction pipelines holding the record current</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>6h</span>
          <span className={styles.statLabel}>
            between sweeps on the per-character feeds; corporation-wide feeds sweep daily — or refresh any of them on
            demand
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>0</span>
          <span className={styles.statLabel}>writes back to your account. It is a receiver, not a transmitter</span>
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>The feed</p>
        <h2 className={styles.sectionTitle}>Nine feeds. One picture.</h2>
        <p className={styles.sectionSub}>
          Most capsuleers run their holdings on spreadsheets, screenshots, and a Discord bot that died two patches ago —
          every source partly right, none agreeing. This is the same data, pulled straight from ESI, in one place that
          agrees with itself.
        </p>
        <div className={styles.cards}>
          {SECTIONS.map(({ label, title, body }) => (
            <article key={title} className={styles.card}>
              <p className={styles.cardLabel}>{label}</p>
              <h3 className={styles.cardTitle}>{title}</h3>
              <p className={styles.cardBody}>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>The doctrine</p>
        <h2 className={styles.sectionTitle}>Why the picture holds</h2>
        <div className={styles.pillars}>
          {DOCTRINE.map(({ title, body }) => (
            <div key={title} className={styles.pillar}>
              <h3 className={styles.pillarTitle}>{title}</h3>
              <p className={styles.pillarBody}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>Standing up the link</p>
        <h2 className={styles.sectionTitle}>Three steps, about a minute</h2>
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

      <section className={styles.quote}>
        <blockquote className={styles.quoteText}>
          “It knows where everything is — every hangar, every can, every wallet division. Including the corpses. It knew
          the corpses by name.”
        </blockquote>
        <p className={styles.quoteAttribution}>— a nullsec logistics director, who asked not to be identified</p>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>Establish the link</h2>
        <p className={styles.closingBody}>
          {user
            ? 'You’re already on the net. Review what landed on the last sweep, or grant a scope you left dark when you added a character.'
            : 'Registration is invite-only; find a member with a code, and you’re about a minute from a single picture of everything you own.'}
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/jobs" className={styles.primary}>
                Review pipeline status
              </Link>
              <Link href="/settings/grants" className={styles.secondary}>
                Manage access grants
              </Link>
            </>
          ) : (
            <>
              <Link href="/account/register" className={styles.primary}>
                Request access
              </Link>
              <Link href="/account/login" className={styles.secondary}>
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

export default Home
