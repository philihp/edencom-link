import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import industryStyles from '../industry.module.css'
import { PlannerTabs } from './plannerTabs'

// The planner's frame: /industry's header strip, then the tab strip, then the
// tab's own page. Each tab is a route segment under this layout, so each loads
// only its own data. The gate is here because every tab is the owner's own
// plan; a signed-out visitor has nothing to see on any of them.
const PlannerLayout = async ({ children }: { children: React.ReactNode }) => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  return (
    <>
      <div className={industryStyles.header}>
        <div>
          <h1 className={industryStyles.title}>planner</h1>
          <div className={industryStyles.subtitle}>what to build, and what it takes to build it</div>
        </div>
        <div className={industryStyles.headerRight}>
          <span className={industryStyles.headerLinks}>
            <Link href="/industry">&laquo; industry</Link>
          </span>
        </div>
      </div>
      <PlannerTabs />
      {children}
    </>
  )
}

export default PlannerLayout
