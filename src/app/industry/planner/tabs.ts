// The planner's tabbed subsections: one route segment under /industry/planner
// per tab, in the order the owner listed them. Pure, so test/plannerTabs.test.ts
// can check the slug ↔ path mapping without a browser.
import { find } from 'ramda'

export const PLANNER_PATH = '/industry/planner'

export type PlannerTab = { slug: string; label: string }

export const PLANNER_TABS: readonly PlannerTab[] = [
  { slug: 'margins', label: 'margins' },
  { slug: 'stock-types', label: 'stock types' },
  { slug: 'invention', label: 'invention' },
  { slug: 'industry', label: 'industry' },
  { slug: 'market', label: 'market' },
  { slug: 'settings', label: 'settings' },
]

// The tab the bare /industry/planner opens: the first in the list.
export const DEFAULT_TAB: PlannerTab = PLANNER_TABS[0]

export const tabPath = (tab: PlannerTab): string => `${PLANNER_PATH}/${tab.slug}`

// The tab a pathname sits under, or null when it is none of them. A trailing
// slash and deeper segments both still belong to their tab.
export const tabForPath = (pathname: string): PlannerTab | null => {
  const rest = pathname.startsWith(`${PLANNER_PATH}/`) ? pathname.slice(PLANNER_PATH.length + 1) : ''
  const slug = rest.split('/')[0]
  return find((t: PlannerTab) => t.slug === slug, PLANNER_TABS) ?? null
}
