import Link from 'next/link'

import { createServiceClient } from '@/utils/supabase/service'

import { DateTime } from '../../DateTime'
import { Name, SystemName } from '../../names'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { fetchSystemNames } from '../../systemNames'
import { fetchTypeNames } from '../../typeNames'
import type { StructureShareScope } from '../access'
import {
  fetchLatestSystemIndexes,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  structureIndexActivities,
} from '../industryIndex'
import { SourceTag } from '../sourceTag'
import styles from '../structures.module.css'

// The share-link (and signed-out public) view of one structure
// (docs/sharing-layer/12-structure-share.md, "The signed link and the public
// case"): the rows a share opens — the corp_structure row, its rigs, and the
// public cost indices for its system — drawn with a service client filtered
// to that ONE structure and its owning corporation, and nothing a share never
// opens: no status (fuel, profile), no jobs, no tax, no revenue. The same
// blocks an alliance-mate does not get signed in.

type SharedRow = {
  structure_id: number | string
  corporation_id: number | string
  type_id: number | string | null
  system_id: number | string | null
  name: string | null
  state: string | null
  unanchors_at: string | null
  reinforce_hour: number | null
  next_reinforce_hour: number | null
  next_reinforce_apply: string | null
  next_reinforce_weekday: number | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string | null
}

const show = (value: string | number | null | undefined) => (value === null || value === undefined ? '—' : value)

export const SharedStructurePage = async ({ scope, viaLink }: { scope: StructureShareScope; viaLink: boolean }) => {
  const supabase = createServiceClient()
  const [{ data: structure }, { data: rigData }, { data: corp }] = await Promise.all([
    supabase
      .from('corp_structure')
      .select(
        'structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, reinforce_hour, next_reinforce_hour, next_reinforce_apply, next_reinforce_weekday, services, last_seen_at'
      )
      .eq('structure_id', scope.structureId)
      .eq('corporation_id', scope.corporationId)
      .maybeSingle<SharedRow>(),
    supabase
      .from('corp_structure_rig')
      .select('type_id, location_flag')
      .eq('structure_id', scope.structureId)
      .eq('corporation_id', scope.corporationId)
      .order('location_flag', { ascending: true }),
    supabase
      .from('corporation')
      .select('name')
      .eq('corporation_id', scope.corporationId)
      .maybeSingle<{ name: string | null }>(),
  ])
  if (!structure) {
    return (
      <>
        <h1>Structure not found</h1>
        <p>This share no longer points at a structure its owner scans.</p>
      </>
    )
  }

  const rigs = (rigData ?? []) as Array<{ type_id: number | string; location_flag: string }>
  const typeNames = await fetchTypeNames([
    ...(structure.type_id != null ? [Number(structure.type_id)] : []),
    ...rigs.map((r) => Number(r.type_id)),
  ])
  const systemIds = structure.system_id != null ? [Number(structure.system_id)] : []
  const [systemNames, indexesBySystem] = await Promise.all([
    fetchSystemNames(systemIds),
    fetchLatestSystemIndexes(supabase, systemIds),
  ])
  const typeName = structure.type_id != null ? typeNames[Number(structure.type_id)] : undefined
  const systemName = structure.system_id != null ? systemNames[Number(structure.system_id)] : undefined
  const indexActivities = structureIndexActivities(structure.services)
  const systemIndexes = structure.system_id != null ? indexesBySystem.get(Number(structure.system_id)) : undefined
  const corporationName = corp?.name ?? `Corporation #${scope.corporationId}`
  const dash = <span className={styles.empty}>—</span>

  return (
    <>
      {viaLink && <ShareUrlCleanup />}
      <div className={styles.detailHeader}>
        <div>
          <p className={styles.backLink}>
            <Link href="/structure">&laquo; structures</Link>
          </p>
          <h1 className={styles.title}>{structure.name ?? `Structure #${structure.structure_id}`}</h1>
          <div className={styles.subtitle}>
            <span className={styles.num}>#{structure.structure_id}</span> ·{' '}
            <Name name={typeName} id={structure.type_id} /> · <SystemName name={systemName} id={structure.system_id} />{' '}
            · <SourceTag source="live" />
          </div>
        </div>
      </div>

      <div className={styles.detailGrid}>
        <section className={styles.panel} aria-label="Structure">
          <div className={styles.panelHead}>
            <h2>structure</h2>
            <span className={styles.spacer} />
            <SourceTag source="live" />
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>shared by</span>
            <span>
              <Name name={corporationName} id={scope.corporationId} />
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>structure id</span>
            <span className={styles.num}>{structure.structure_id}</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>type</span>
            <span>
              <Name name={typeName} id={structure.type_id} />
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>system</span>
            <span>
              <SystemName name={systemName} id={structure.system_id} />
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>state</span>
            <span>{show(structure.state)}</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>unanchors at</span>
            <span className={styles.num}>
              <DateTime value={structure.unanchors_at} />
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>reinforce hour</span>
            <span className={styles.num}>{show(structure.reinforce_hour)}</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>next reinforce hour</span>
            <span className={styles.num}>{show(structure.next_reinforce_hour)}</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>next reinforce weekday</span>
            <span className={styles.num}>{show(structure.next_reinforce_weekday)}</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>next reinforce apply</span>
            <span className={styles.num}>
              <DateTime value={structure.next_reinforce_apply} />
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>services</span>
            <span className={styles.wrap}>
              {structure.services ? structure.services.map((svc) => `${svc.name} (${svc.state})`).join(', ') : dash}
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>rigs</span>
            <span className={styles.wrap}>
              {rigs.length > 0 ? rigs.map((r) => typeNames[Number(r.type_id)] ?? `#${r.type_id}`).join(', ') : dash}
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>industry indexes</span>
            <span className={styles.wrap}>
              {indexActivities.length > 0
                ? indexActivities.map((activity, i) => {
                    const cost = systemIndexes?.get(activity)
                    return (
                      <span key={activity}>
                        {i > 0 && ', '}
                        {INDEX_ACTIVITY_LABELS[activity]}{' '}
                        <span className={styles.num}>{cost != null ? formatIndex(cost) : '—'}</span>
                      </span>
                    )
                  })
                : dash}
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>last seen</span>
            <span className={styles.num}>
              <DateTime value={structure.last_seen_at} />
            </span>
          </div>
        </section>

        <div className={styles.detailColumn}>
          <p className={styles.plainNote}>
            Shared by {corporationName}. A structure share opens its details, services and rigs — never its fuel, its
            revenue or the jobs running in it.
          </p>
        </div>
      </div>
    </>
  )
}
