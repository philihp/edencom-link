import Link from 'next/link'
import { createClient } from '@/utils/supabase/server'
import styles from './home.module.css'

// The module suite, pitched the way an ERP vendor would pitch NetSuite or SAP:
// every EVE surface recast as an enterprise line-of-business module.
const MODULES = [
  {
    label: 'Financials',
    title: 'Financial Management',
    body: 'Consolidated wallets across every character, corporation division ledgers, and journal rollups by reference type. Close the books on your empire without alt-tabbing through eleven clients.',
  },
  {
    label: 'Inventory',
    title: 'Warehouse & Inventory',
    body: 'Every item, every station, every nested container — one searchable warehouse system with location drill-down, stack counts, and point-in-time snapshots of what you held before downtime.',
  },
  {
    label: 'Manufacturing',
    title: 'Manufacturing & MRP',
    body: 'Industry jobs, blueprint portfolios with ME/TE research tracking, slot capacity planning from trained skills, and system cost indices. Material requirements planning that knows which rigs are fitted to your structures.',
  },
  {
    label: 'Orders',
    title: 'Order Management',
    body: 'Open market orders and full transaction history across characters and corp divisions, unified into one trade ledger. Know what filled, what expired, and what it all cleared at.',
  },
  {
    label: 'Facilities',
    title: 'Enterprise Asset Management',
    body: 'Your Upwell structures as managed facilities: fuel runway, service modules, fitted rigs, reinforcement state, and industry-tax revenue per structure per day.',
  },
  {
    label: 'Workforce',
    title: 'Clone Capital Management',
    body: 'The HR module, adapted for a workforce that respawns. Characters, jump clones, implant loadouts, skill training history, and jump-timer availability — your entire distributed labor pool on one screen.',
  },
  {
    label: 'Field ops',
    title: 'Field Operations',
    body: 'Mercenary den deployments with development and anarchy telemetry, reinforcement timers, and opt-in intel sharing scoped to exactly one alliance. Territory management as a first-class module.',
  },
  {
    label: 'Analytics',
    title: 'Business Intelligence',
    body: 'CSV endpoints built for Google Sheets =IMPORTDATA(), keyed to a personal token, with time-travel queries against any historical date. Your dashboards, your formulas, our system of record.',
  },
  {
    label: 'AI',
    title: 'AI Copilot',
    body: 'An OAuth-authorized MCP server, so an AI assistant can field “which blueprints are worth researching” or “appraise my Jita hangar” against exactly the data your account can see — never more.',
  },
]

// The platform pitch: the governance section every ERP vendor leads with,
// except here the claims are structural rather than aspirational.
const PILLARS = [
  {
    title: 'A single source of truth',
    body: 'Every asset, order, job, and blueprint is versioned rather than replaced — a full audit trail on every record. “When did that stack move?” is a query, not an argument.',
  },
  {
    title: 'Role-based access, all the way down',
    body: 'Row-level security scopes every read to your account. Grants are per-scope at SSO time, and shares are cut deliberately thin: one ship, one alliance’s intel, one public page.',
  },
  {
    title: 'Read-only by design',
    body: 'The platform holds no write permission against your account and never asks for one. It observes your enterprise; it cannot touch it.',
  },
]

const STEPS = [
  {
    title: 'Discovery & integration',
    body: 'Link a character through EVE SSO. Each permission is granted one scope at a time — the modules you skip are simply the ones that stay dark.',
  },
  {
    title: 'Data migration',
    body: 'Scheduled extraction pipelines pull every endpoint into the system of record and keep every version. No consultants, no cutover weekend.',
  },
  {
    title: 'Go-live',
    body: 'Browse the modules, wire up a spreadsheet, hand out a scoped share link, or point an AI assistant at your data. Day two looks like day one, but fresher.',
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
          Capsuleer Resource Planning
        </p>
        <h1 className={styles.headline}>One platform to run your entire space empire.</h1>
        <p className={styles.sub}>
          Edencom Link unifies financials, inventory, manufacturing, order management and field operations across every
          character and corporation you fly. One system of record, continuously synchronized from ESI, with a complete
          audit trail on every asset — from your first frigate to the ten-millionth unit of Tritanium.
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/asset" className={styles.primary}>
                Open your workspace
              </Link>
              <Link href="/character/" className={styles.secondary}>
                Onboard a character
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
        <p className={styles.microcopy}>Invite-only deployment · read-only ESI access · you choose the scopes</p>
      </section>

      <section className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>18</span>
          <span className={styles.statLabel}>integrated extraction pipelines keeping the system of record current</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>6h</span>
          <span className={styles.statLabel}>maximum sync latency — or refresh any pipeline on demand</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>0</span>
          <span className={styles.statLabel}>write-backs to production. Your account is read, never touched</span>
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>The suite</p>
        <h2 className={styles.sectionTitle}>Nine modules. One system of record.</h2>
        <p className={styles.sectionSub}>
          Most capsuleers run their enterprise on spreadsheets, screenshots, and a Discord bot that stopped working two
          patches ago. Edencom Link replaces the pile with an integrated suite.
        </p>
        <div className={styles.cards}>
          {MODULES.map(({ label, title, body }) => (
            <article key={title} className={styles.card}>
              <p className={styles.cardLabel}>{label}</p>
              <h3 className={styles.cardTitle}>{title}</h3>
              <p className={styles.cardBody}>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>The platform</p>
        <h2 className={styles.sectionTitle}>Governance your alliance auditor would approve of</h2>
        <div className={styles.pillars}>
          {PILLARS.map(({ title, body }) => (
            <div key={title} className={styles.pillar}>
              <h3 className={styles.pillarTitle}>{title}</h3>
              <p className={styles.pillarBody}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>Implementation</p>
        <h2 className={styles.sectionTitle}>Deployed in minutes, not fiscal quarters</h2>
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
          “Before Edencom Link, our quarterly close meant alt-tabbing through eleven hangars and trusting a spreadsheet
          last edited before the war. Now I know where every asset is — including the corpses.”
        </blockquote>
        <p className={styles.quoteAttribution}>— Director of Logistics, an undisclosed nullsec alliance</p>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>
          {user ? 'Your enterprise, already running.' : 'Ready to modernize your empire?'}
        </h2>
        <p className={styles.closingBody}>
          {user
            ? 'Your extraction pipelines are live. Review what landed recently, or grant a scope you skipped during onboarding.'
            : 'Deployment is invite-only. If you have a code, onboarding takes about a minute — no consultants, no implementation partner, no six-quarter rollout.'}
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
