import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { DateTime } from '../DateTime'
import { establishedUser } from '../account/lib/establishedUser'
import { CopyLinkButton } from './copyButton'
import { issuanceLabel } from './issuance'
import { LinkEditor } from './linkEditor'
import type { LinkRecord } from './run'
import styles from './link.module.css'

// Dark-launched Link index (docs/sharing-layer/07-link.md; no nav link):
// saved GraphQL queries that run under YOUR context when someone you shared
// them with opens them. Gated on the per-account `link` flag, the same
// gate-and-redirect shape as /graphql.
//
// This page is a directory listing and nothing else: name, who it's issued to,
// when it last changed. Opening one goes to its own page, where the query is
// edited, exported and issued. It used to stack a full editor and a share
// dialog per row, which made scanning ten Links a scroll rather than a look.
export const dynamic = 'force-dynamic'

const LinkPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  // RLS shows the caller's own links AND ones shared with them (the audience
  // policy) — one read, split into the caller's own directory and the one of
  // Links issued to them.
  const { data: linkRows } = await supabase.from('link').select('*').order('name')
  const visible = (linkRows ?? []) as LinkRecord[]
  const links = visible.filter((l) => l.user_id === user.id)
  const sharedWithMe = visible.filter((l) => l.user_id !== user.id)

  return (
    <>
      <h1>Data Links</h1>
      <p>
        A Link is a standing query registered against your materiel, works orders and fund position. It is issued to a
        corporation, to an alliance, to whoever holds a signed URL, or to everyone. Whoever opens it runs the query and
        receives <em>your</em> results — a reading, never access to the registry behind it. Every Link also renders as
        CSV, for operators who reconcile by spreadsheet.
      </p>

      <LinkEditor link={null} />

      {links.length === 0 ? (
        <p className={styles.note}>
          No Links registered. Observation is not currently delegated to anyone. This has been logged.
        </p>
      ) : (
        <ul className={styles.listing}>
          <li className={styles.listingHead}>
            <span>Name</span>
            <span>Issued to</span>
            <span>Updated</span>
          </li>
          {links.map((link) => (
            <li key={link.id} className={styles.row}>
              <Link href={`/link/${link.id}`} className={styles.rowName}>
                <span aria-hidden="true" className={styles.glyph}>
                  ▤
                </span>
                {link.name}
              </Link>
              <span className={link.enabled ? undefined : styles.rowQuiet}>{issuanceLabel(link)}</span>
              <span className={styles.rowQuiet}>
                <DateTime value={link.updated_at} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {sharedWithMe.length > 0 && (
        <>
          <h2>Issued to you</h2>
          <p className={styles.note}>
            Links other operators have issued to you. Opening one reports <em>their</em> holdings. Retaining a copy
            keeps the query, registered as your own Link and run against your own.
          </p>
          <ul className={styles.listing}>
            <li className={styles.listingHead}>
              <span>Name</span>
              <span>Updated</span>
              <span />
            </li>
            {sharedWithMe.map((link) => (
              <li key={link.id} className={styles.row}>
                <Link href={`/link/${link.id}`} className={styles.rowName}>
                  <span aria-hidden="true" className={styles.glyph}>
                    ▤
                  </span>
                  {link.name}
                </Link>
                <span className={styles.rowQuiet}>
                  <DateTime value={link.updated_at} />
                </span>
                <span className={styles.rowActions}>
                  <CopyLinkButton linkId={link.id} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

export default LinkPage
