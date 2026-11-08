import { redirect } from 'next/navigation'

import { DEFAULT_TAB, tabPath } from './tabs'

// The bare /industry/planner is the first tab.
const PlannerPage = () => redirect(tabPath(DEFAULT_TAB))

export default PlannerPage
