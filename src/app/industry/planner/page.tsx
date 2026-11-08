import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import industryStyles from '../industry.module.css'
import styles from './planner.module.css'

// The industry planner. Today this is the frame only: the header strip in the
// shape of /industry's, and one empty panel where the plan goes. What the
// planner does is still being designed (see the thread that opened this
// route), so the page says so instead of guessing at a feature.
const PlannerPage = async () => {
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

      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>plan</span>
        </div>
        <p className={styles.empty}>Nothing is planned yet.</p>
      </section>
    </>
  )
}

export default PlannerPage
