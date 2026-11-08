import { map } from 'ramda'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { formatIskValue } from '../../../isk'
import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import { totalEiv, type StockTarget } from './stockTargets'
import { StockTypesTable, type StockRow } from './stockTypesTable'

type TargetRow = { type_id: number | string; backup: number; home: number; jita: number }
type PriceRow = { type_id: number | string; adjusted_price: number | string | null }

// The stock directive: the account's list of item types and how many of each
// to hold, with the total EIV it asks for at the top. The layout above has
// already turned a signed-out visitor away; RLS scopes the rows to the account.
const StockTypesPage = async () => {
  const supabase = await createClient()

  const { data } = await supabase
    .from('planner_stock_target')
    .select('type_id, backup, home, jita')
    .order('created_at', { ascending: true })
    .returns<TargetRow[]>()
  const targets: StockTarget[] = map(
    (r) => ({ typeId: Number(r.type_id), backup: r.backup, home: r.home, jita: r.jita }),
    data ?? []
  )
  const typeIds = targets.map((t) => t.typeId)

  const [types, { data: priceRows }] = await Promise.all([
    getSdeTypes(typeIds),
    typeIds.length > 0
      ? supabase
          .from('market_adjusted_price')
          .select('type_id, adjusted_price')
          .in('type_id', typeIds)
          .returns<PriceRow[]>()
      : Promise.resolve({ data: [] as PriceRow[] }),
  ])
  const prices = new Map<number, number>(
    (priceRows ?? [])
      .filter((p) => p.adjusted_price !== null)
      .map((p) => [Number(p.type_id), Number(p.adjusted_price)] as [number, number])
  )

  const rows: StockRow[] = map(
    (t) => ({
      ...t,
      name: types[t.typeId]?.name ?? `#${t.typeId}`,
      categoryID: types[t.typeId]?.categoryID ?? null,
      price: prices.get(t.typeId) ?? null,
    }),
    targets
  )
  const { eiv, unpriced } = totalEiv(targets, prices)

  return (
    <section className={industryStyles.panel}>
      <div className={industryStyles.panelHead}>
        <span className={industryStyles.panelTitle}>stock types</span>
        <span className={styles.panelStat}>
          <span className={industryStyles.faint}>total EIV</span>{' '}
          <span className={industryStyles.mono}>{formatIskValue(eiv)} ISK</span>
          {unpriced > 0 && (
            <span className={industryStyles.faint}>
              {' '}
              · {unpriced} {unpriced === 1 ? 'type' : 'types'} unpriced
            </span>
          )}
        </span>
        <span className={styles.panelCount}>
          <span className={industryStyles.mono}>{rows.length}</span> {rows.length === 1 ? 'type' : 'types'}
        </span>
      </div>
      <StockTypesTable key={rows.map((r) => r.typeId).join(',')} rows={rows} />
      <div className={industryStyles.panelFoot}>
        EIV: every unit the list asks for, at CCP&apos;s adjusted price for the type · arrow keys step a quantity · a
        cell saves when you leave it
      </div>
    </section>
  )
}

export default StockTypesPage
