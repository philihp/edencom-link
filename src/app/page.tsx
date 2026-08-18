import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from './account/lib/establishedUser'
import styles from './home.module.css'

// EDENCOM was chartered to make four rival empires read one threat picture.
// The sections below are that picture, narrowed to a single capsuleer's holdings:
// every feed named for what it watches, not for the ESI endpoint behind it.
const SECTIONS = [
  {
    label: 'Treasury',
    title: 'Treasury & Ledger',
    body: 'Consolidated wallets across every character, corporation division ledgers, and journal rollups by reference type. Where the ISK came from and where it went, without alt-tabbing through eleven clients to find out.',
  },
  {
    label: 'Materiel',
    title: 'Materiel Registry',
    body: 'Every item, every station, every nested container — one searchable registry with location drill-down, stack counts, and a reconstruction of what you held before any given downtime.',
  },
  {
    label: 'Production',
    title: 'Production & Supply',
    body: 'Industry jobs, blueprint holdings with ME/TE research state, slot capacity read off trained skills, and system cost indices. Supply planning that already knows which rigs are fitted to your structures.',
  },
  {
    label: 'Market',
    title: 'Market Traffic',
    body: 'Open orders and full transaction history across characters and corp divisions, resolved into one trade record. What filled, what expired, and what it all cleared at.',
  },
  {
    label: 'Holdings',
    title: 'Fortifications',
    body: 'Your Upwell structures as held positions: fuel runway, service modules, fitted rigs, reinforcement state, and industry-tax revenue per structure per day. A fortress is only a fortress while the fuel lasts.',
  },
  {
    label: 'Personnel',
    title: 'Capsuleer Registry',
    body: 'The personnel file, adapted for personnel who respawn. Characters, jump clones, implant loadouts, skill training history, and jump-timer availability — the whole distributed roster on one screen.',
  },
  {
    label: 'Field ops',
    title: 'Forward Operations',
    body: 'Mercenary den deployments with development and anarchy telemetry, reinforcement timers, and opt-in intel sharing scoped to exactly one alliance. The part of the picture worth handing to someone else.',
  },
  {
    label: 'Telemetry',
    title: 'Telemetry Export',
    body: 'CSV feeds built for Google Sheets =IMPORTDATA(), keyed to a personal token, answerable for any historical date. Your dashboards, your formulas, reading off the same record everything else here reads.',
  },
  {
    label: 'Advisory',
    title: 'Advisory Interface',
    body: 'An OAuth-authorized MCP server, so an AI assistant can field “which blueprints are worth researching” or “appraise my Jita hangar” against exactly the data your account can see — never one row more.',
  },
]

// EDENCOM's actual innovation was never the Vorton projector. It was getting
// four states that had been shooting at each other to trust one feed — which
// took a doctrine about what the feed may and may not do.
const DOCTRINE = [
  {
    title: 'The record is never overwritten',
    body: 'Every asset, order, job, and blueprint is versioned rather than replaced. Nothing is quietly corrected after the fact, so “when did that stack move?” is a query instead of an argument.',
  },
  {
    title: 'Clearance is compartmented',
    body: 'Row-level security scopes every read to your account. Access is granted one ESI scope at a time, and anything you share is cut deliberately thin: one ship, one alliance’s intel, one public page.',
  },
  {
    title: 'Observation, never command',
    body: 'The link holds no write permission against your account and never asks for one. It watches your holdings; it cannot touch them, undock them, or spend them.',
  },
]

const STEPS = [
  {
    title: 'Accreditation',
    body: 'Link a character through EVE SSO. Each permission is granted one scope at a time — the feeds you skip are simply the ones that stay dark.',
  },
  {
    title: 'Datalink established',
    body: 'Scheduled pipelines pull every endpoint into the record and keep every version of it. Backfill is automatic; there is no cutover and nothing to import by hand.',
  },
  {
    title: 'Standing watch',
    body: 'Read the sections, wire up a spreadsheet, hand out a scoped share link, or point an AI assistant at it. The picture stays current whether or not you are looking at it.',
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
          EDENCOM was chartered to make four empires that had spent a millennium shooting at each other read the same
          threat picture. Edencom Link does the smaller, harder version of that job: one continuously synchronized
          record across every character and corporation you fly, with a full history behind every line of it — from your
          first frigate to the ten-millionth unit of Tritanium.
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/asset" className={styles.primary}>
                Open the link
              </Link>
              <Link href="/character/" className={styles.secondary}>
                Accredit a character
              </Link>
            </>
          ) : (
            <>
              <Link href="/account/register" className={styles.primary}>
                Request accreditation
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
        <h2 className={styles.sectionTitle}>Nine sections. One record.</h2>
        <p className={styles.sectionSub}>
          Most capsuleers run their holdings on spreadsheets, screenshots, and a Discord bot that stopped working two
          patches ago — every source disagreeing with every other. Edencom Link replaces the pile with one feed that
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
        <h2 className={styles.sectionTitle}>A shared picture is only worth what its rules are worth</h2>
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
        <h2 className={styles.sectionTitle}>Live inside a downtime</h2>
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
          “Before the link, knowing where anything was meant alt-tabbing through eleven hangars and trusting a
          spreadsheet last edited before the war. Now I know where every asset is — including the corpses.”
        </blockquote>
        <p className={styles.quoteAttribution}>— Logistics director, an undisclosed nullsec alliance</p>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>
          {user ? 'The watch is already standing.' : 'Come read the same picture.'}
        </h2>
        <p className={styles.closingBody}>
          {user
            ? 'Your pipelines are live and sweeping. Review what landed most recently, or grant a scope you left dark during accreditation.'
            : 'Accreditation is invite-only. If you hold a code, standing up the link takes about a minute — no import, no cutover, no waiting on a downtime.'}
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
                Request accreditation
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
