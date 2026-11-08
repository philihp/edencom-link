'use client'
// The tab strip under the planner's header. Each tab is a link to its own
// route segment, so a tab is a URL you can share and the browser's back button
// walks between tabs; the active one is read from the pathname.
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import styles from './planner.module.css'
import { PLANNER_TABS, tabForPath, tabPath } from './tabs'

export const PlannerTabs = () => {
  const active = tabForPath(usePathname())
  return (
    <nav role="tablist" aria-label="Planner sections" className={styles.tabs}>
      {PLANNER_TABS.map((tab) => {
        const selected = active?.slug === tab.slug
        return (
          <Link
            key={tab.slug}
            href={tabPath(tab)}
            role="tab"
            aria-selected={selected}
            className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
