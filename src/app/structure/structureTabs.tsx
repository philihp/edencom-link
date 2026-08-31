'use client'
// The tile's lower pane: Services, Rigs and Characters share one footprint
// behind tabs instead of stacking three full sections. Characters are the
// people who ran industry jobs at the structure inside the page's window —
// our own characters by registration, corpmates by the installer id the corp
// extract carries — so a tile answers "who actually uses this place" without
// leaving the page.
import { useState } from 'react'

import { TypeIcon } from '../typeIcon'
import styles from './structures.module.css'

export type ServiceChip = { name: string; typeID: number | null }
export type RigChip = { name: string; typeID: number }
export type CharacterRow = { key: string; name: string; jobs: number; eiv: number }

// Approximate throughput, to the nearest million ISK. The EIV fold prices at
// CCP adjusted prices, so this is already an estimate — millions is the honest
// precision, and "—" is a person whose jobs here carried no priceable EIV
// (research, or a bill the mirror couldn't price).
const formatEivM = (eiv: number): string =>
  eiv > 0 ? `~${Math.round(eiv / 1_000_000).toLocaleString('en-US')}m ISK` : '—'

type TabDef = { id: 'services' | 'rigs' | 'characters'; label: string; count: number }

export const StructureTabs = ({
  services,
  rigs,
  characters,
}: {
  services: ServiceChip[]
  rigs: RigChip[]
  characters: CharacterRow[]
}) => {
  const tabs: TabDef[] = [
    { id: 'services' as const, label: 'Services', count: services.length },
    { id: 'rigs' as const, label: 'Rigs', count: rigs.length },
    { id: 'characters' as const, label: 'Characters', count: characters.length },
  ].filter((t) => t.count > 0)
  const [active, setActive] = useState(tabs[0]?.id)

  if (tabs.length === 0) return null
  const current = tabs.some((t) => t.id === active) ? active : tabs[0].id

  return (
    <div className={styles.tabbed}>
      <div role="tablist" className={styles.tabList}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current === t.id}
            className={current === t.id ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => setActive(t.id)}
          >
            {t.label}
            <span className={styles.tabCount}>{t.count}</span>
          </button>
        ))}
      </div>

      {current === 'services' && (
        <ul role="tabpanel" className={styles.chips}>
          {services.map((svc, i) => (
            <li key={`svc-${i}`} className={styles.chip}>
              {svc.typeID != null && <TypeIcon id={svc.typeID} size={32} className={styles.chipIcon} />}
              {svc.name}
            </li>
          ))}
        </ul>
      )}

      {current === 'rigs' && (
        <ul role="tabpanel" className={styles.chips}>
          {rigs.map((rig, i) => (
            <li key={`rig-${i}`} className={styles.chip}>
              <TypeIcon id={rig.typeID} size={32} className={styles.chipIcon} />
              {rig.name}
            </li>
          ))}
        </ul>
      )}

      {current === 'characters' && (
        <ul role="tabpanel" className={styles.characterList}>
          {characters.map((c) => (
            <li key={c.key} className={styles.characterRow}>
              <span className={styles.characterName}>{c.name}</span>
              <span className={styles.characterJobs}>{formatEivM(c.eiv)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
