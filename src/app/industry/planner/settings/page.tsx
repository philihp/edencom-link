import Link from 'next/link'
import { map, uniq } from 'ramda'

import { getSdeSystemNames } from '@/sdeSystems'
import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../account/lib/establishedUser'
import { fetchTaxRates, formatRate } from '../../../settings/tax/rates'
import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import { BuildBuyList, ManualStockList, type BuildBuyRow, type ManualStockRow } from './manualLists'
import { fetchPlannerSettings } from './read'
import { facilityTaxRate, type BuildBuy } from './settings'
import { SettingsForm } from './settingsForm'

type BuildBuyDbRow = { type_id: number | string; choice: BuildBuy }
type ManualStockDbRow = { type_id: number | string; quantity: number | string }
type FavoriteRow = { structure_id: number | string }
type StructureRow = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
  owner_corporation_id: number | string | null
}
type RegistrationRow = { corporation_id: number | string | null }

const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v))

// The settings tab: the plan's numbers, where it builds (the starred
// structures and the tax it assumes in each), and the two manual lists. The
// layout has already turned a signed-out visitor away; RLS scopes every row.
const SettingsPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)

  const [settings, { data: buildBuy }, { data: manualStock }, { data: favorites }, { data: regs }, rates] =
    await Promise.all([
      fetchPlannerSettings(supabase),
      supabase
        .from('planner_build_buy')
        .select('type_id, choice')
        .order('created_at', { ascending: true })
        .returns<BuildBuyDbRow[]>(),
      supabase
        .from('planner_manual_stock')
        .select('type_id, quantity')
        .order('created_at', { ascending: true })
        .returns<ManualStockDbRow[]>(),
      supabase
        .from('structure_favorite')
        .select('structure_id')
        .order('position', { ascending: true })
        .returns<FavoriteRow[]>(),
      supabase.from('registration').select('corporation_id').returns<RegistrationRow[]>(),
      fetchTaxRates(supabase, user?.id ?? ''),
    ])

  const favoriteIds = map((f) => Number(f.structure_id), favorites ?? [])
  const { data: structures } =
    favoriteIds.length > 0
      ? await supabase
          .from('universe_structure')
          .select('structure_id, name, system_id, owner_corporation_id')
          .in('structure_id', favoriteIds)
          .returns<StructureRow[]>()
      : { data: [] as StructureRow[] }
  const byId = new Map((structures ?? []).map((s) => [Number(s.structure_id), s] as const))
  const ownCorps = new Set((regs ?? []).filter((r) => r.corporation_id !== null).map((r) => Number(r.corporation_id)))

  const typeIds = uniq([...(buildBuy ?? []), ...(manualStock ?? [])].map((r) => Number(r.type_id)))
  const systemIds = uniq((structures ?? []).filter((s) => s.system_id !== null).map((s) => Number(s.system_id)))
  const [types, systemNames] = await Promise.all([getSdeTypes(typeIds), getSdeSystemNames(systemIds)])
  const typeOf = (typeId: number) => ({
    typeId,
    name: types[typeId]?.name ?? `#${typeId}`,
    categoryID: types[typeId]?.categoryID ?? null,
  })

  const buildBuyRows: BuildBuyRow[] = map((r) => ({ ...typeOf(Number(r.type_id)), choice: r.choice }), buildBuy ?? [])
  const manualRows: ManualStockRow[] = map(
    (r) => ({ ...typeOf(Number(r.type_id)), quantity: Number(r.quantity) }),
    manualStock ?? []
  )

  return (
    <>
      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>settings</span>
        </div>
        <SettingsForm settings={settings} />
      </section>

      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>where the plan builds</span>
          <span className={styles.panelCount}>
            <span className={industryStyles.mono}>{favoriteIds.length}</span> starred
          </span>
        </div>
        {favoriteIds.length > 0 ? (
          <div className={industryStyles.tableScroll}>
            <table className={industryStyles.table}>
              <thead>
                <tr>
                  <th>structure</th>
                  <th>system</th>
                  <th className={industryStyles.num}>facility tax</th>
                </tr>
              </thead>
              <tbody>
                {favoriteIds.map((id) => {
                  const s = byId.get(id)
                  const owner = numOrNull(s?.owner_corporation_id ?? null)
                  const own = owner !== null && ownCorps.has(owner)
                  const systemId = numOrNull(s?.system_id ?? null)
                  return (
                    <tr key={id} className={industryStyles.row}>
                      <td>{s?.name ?? `#${id}`}</td>
                      <td>{systemId === null ? '—' : (systemNames[systemId] ?? `#${systemId}`)}</td>
                      <td className={industryStyles.num}>
                        {formatRate(facilityTaxRate(owner, ownCorps, rates))}{' '}
                        <span className={industryStyles.faint}>{own ? 'own' : 'public'}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>
            No starred structures. Star the structures you build in on <Link href="/structure">structures</Link>.
          </p>
        )}
        <div className={industryStyles.panelFoot}>
          Each job goes to the starred structure where it costs least, with the best rig there and that system&apos;s
          current cost index · star structures on <Link href="/structure">structures</Link> · tax rates on{' '}
          <Link href="/settings/tax">tax settings</Link>
        </div>
      </section>

      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>always build or buy</span>
          <span className={styles.panelCount}>
            <span className={industryStyles.mono}>{buildBuyRows.length}</span>{' '}
            {buildBuyRows.length === 1 ? 'type' : 'types'}
          </span>
        </div>
        <BuildBuyList key={buildBuyRows.map((r) => r.typeId).join(',')} rows={buildBuyRows} />
        <div className={industryStyles.panelFoot}>A type listed here ignores prices when the plan decides.</div>
      </section>

      <section className={industryStyles.panel}>
        <div className={industryStyles.panelHead}>
          <span className={industryStyles.panelTitle}>manual stock</span>
          <span className={styles.panelCount}>
            <span className={industryStyles.mono}>{manualRows.length}</span>{' '}
            {manualRows.length === 1 ? 'type' : 'types'}
          </span>
        </div>
        <ManualStockList key={manualRows.map((r) => r.typeId).join(',')} rows={manualRows} />
        <div className={industryStyles.panelFoot}>
          Items the extracts cannot see, counted as on hand in addition to them · a count saves when you leave it
        </div>
      </section>
    </>
  )
}

export default SettingsPage
