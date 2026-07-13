import { redirect } from 'next/navigation'

import { mercenaryDensFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { STAGING, TEMPERATE_PLANETS } from './data'
import ShareToggle from './shareToggle'
import { Topology } from './topology'
import styles from './mercenaryDens.module.css'

// Hand-maintained static intel; nothing here moves per request, but keep it
// server-rendered behind the auth + flag gates.
export const dynamic = 'force-dynamic'

const MercenaryDensPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  if (!(await mercenaryDensFlag())) {
    redirect('/')
  }

  const { data: settings } = await supabase.from('user_settings').select('share_mercenary_dens').maybeSingle()

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Mercenary Dens</h1>
        <ShareToggle initialShared={settings?.share_mercenary_dens ?? false} />
      </div>
      <p className={styles.subtitle}>
        Systems immediately accessible from our staging system, <span className={styles.system}>{STAGING}</span>.
      </p>

      <Topology />

      <h2>Temperate planets</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>System</th>
            <th>Planet</th>
            <th>Den owner</th>
            <th>Alliance</th>
            <th>Reinforced</th>
          </tr>
        </thead>
        <tbody>
          {TEMPERATE_PLANETS.map(({ system, planet, den }, i) => (
            <tr key={`${system}-${planet}-${i}`}>
              <td className={styles.system}>{system}</td>
              <td className={styles.planet}>{planet}</td>
              <td>{den ? den.owner : <span className={styles.empty}>— none —</span>}</td>
              <td>{den?.alliance ?? <span className={styles.empty}>—</span>}</td>
              <td>
                {den ? (
                  den.reinforced ? (
                    <span className={styles.reinforced}>reinforced</span>
                  ) : (
                    <span className={styles.stable}>stable</span>
                  )
                ) : (
                  <span className={styles.empty}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
export default MercenaryDensPage
