import type { Metadata } from 'next'

import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Privacy Policy — Edencom Link',
}

const REPO = 'https://github.com/philihp/edencom-link'

const PrivacyPage = () => (
  <main className={styles.wrap}>
    <h1>Privacy Policy</h1>
    <p className={styles.updated}>Last updated: 19 July 2026</p>

    <p>
      Edencom Link (&ldquo;the site&rdquo;) is a hobby tool for tracking your own EVE Online characters&rsquo; assets,
      wallet, industry, and structures. This page explains what it stores and why, in plain terms. If anything is
      unclear, ask via the <a href={REPO}>GitHub repository</a>.
    </p>

    <h2>What we collect</h2>
    <ul>
      <li>
        <strong>Account credentials.</strong> When you register, Supabase Auth stores your email address and a hashed
        password.
      </li>
      <li>
        <strong>EVE character links.</strong> When you add an EVE Online character, we store its character ID and name
        and the OAuth tokens EVE SSO issues us (an access token and a refresh token), so we can read the data you
        authorized on your behalf.
      </li>
      <li>
        <strong>Game data from ESI.</strong> Using those tokens, scheduled jobs pull the data you granted access to —
        assets, wallet balance and transactions, market orders, industry jobs, blueprints, clones and implants, current
        location and ship, mercenary dens, and corporation structures, assets, and wallet where you hold the in-game
        roles. We keep a history of this data over time, so older versions are retained rather than only the latest
        snapshot.
      </li>
      <li>
        <strong>Preferences.</strong> Settings such as the systems you choose to watch and an optional API token you can
        generate for spreadsheet exports.
      </li>
      <li>
        <strong>Discord (if you enable notifications).</strong> If you link a Discord channel to receive alerts, we
        store the Discord server (guild) and channel IDs, their display names, and the Discord user ID of whoever ran
        the link command.
      </li>
    </ul>

    <h2>What we do with it</h2>
    <ul>
      <li>We show your data back to you, on your account&rsquo;s pages.</li>
      <li>
        We share data only where you opt in: with a corporation you belong to (corp assets and industry, mercenary-den
        sharing), through public share links you generate yourself (a ship&rsquo;s fit, or the corpses page, which stays
        off unless you enable it), or to a Discord channel you link.
      </li>
      <li>We do not sell your data or share it with advertisers.</li>
    </ul>

    <h2>Where your data lives, and who else sees it</h2>
    <ul>
      <li>
        <strong>Supabase</strong> stores the database and handles authentication.
      </li>
      <li>
        <strong>Vercel</strong> hosts the site and provides its analytics and performance monitoring (Vercel Analytics
        and Speed Insights), which collect anonymous usage and page-performance data.
      </li>
      <li>
        <strong>CCP / EVE Online ESI</strong> is the source of the game data and where your EVE authorization is
        managed.
      </li>
      <li>
        <strong>Discord</strong> receives any notifications you configure. Messages posted to a Discord channel are
        visible to that channel&rsquo;s members and governed by Discord&rsquo;s own terms and privacy policy.
      </li>
    </ul>

    <h2>Keeping and removing your data</h2>
    <ul>
      <li>
        You can revoke this site&rsquo;s access to an EVE character at any time from your EVE Online account&rsquo;s
        third-party application settings on CCP&rsquo;s side. Once revoked, we can no longer refresh tokens or pull new
        data for that character.
      </li>
      <li>To have your account and its stored data deleted, contact us (below) and we will remove it.</li>
      <li>Unlinking a Discord channel stops notifications to it and removes the stored channel link.</li>
    </ul>

    <h2>Contact</h2>
    <p>
      For questions or deletion requests, open an issue on the project&rsquo;s <a href={REPO}>GitHub repository</a>.
    </p>
  </main>
)

export default PrivacyPage
