import { redirect } from 'next/navigation'

import { mercenaryDensFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { fetchOwners } from '../owners'
import { STAGING, TEMPERATE_PLANETS } from './data'
import ShareCorps from './shareCorps'
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

  // The caller's corporations (to offer as share targets) and which of them
  // their dens are currently shared with.
  const { corporations } = await fetchOwners(supabase)
  const { data: myRegs } = await supabase.from('registration').select('id')
  const registrationIds = (myRegs ?? []).map((r) => r.id)
  const { data: shares } = registrationIds.length
    ? await supabase.from('character_mercenary_den_share').select('corporation_id').in('character_id', registrationIds)
    : { data: [] }
  const sharedCorpIds = [...new Set((shares ?? []).map((s) => String(s.corporation_id)))]

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Mercenary Dens</h1>
        <ShareCorps corporations={corporations} sharedCorpIds={sharedCorpIds} />
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
