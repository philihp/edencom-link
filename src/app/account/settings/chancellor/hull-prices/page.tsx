import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ascend, sortWith } from 'ramda'

import { getHullPriceRows, HULL_PRICE_GROUP_IDS } from '@/hullPrices'
import { formatBisk as formatBiskUnit } from '@/app/isk'
import { getSdeTypesInGroups, type SdeType } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../lib/establishedUser'
import { isChancellor } from '../chancellor'
import { formatBisk } from './bisk'
import HullPriceForm from './hullPriceForm'

// Chancellor-set prices for the hulls no market prices. Supercarriers and
// titans cannot enter high-sec, so they sell by contract, mostly inside an
// alliance; the price floats and nobody publishes it. What is set here is what
// the ship card and the Appraise button use for the hull (hull_price).
//
// Every published supercarrier and titan is listed, faction hulls included,
// straight from the SDE groups, so a hull CCP adds shows up by itself.

const HullPricesPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login')
  if (!(await isChancellor(user.id))) redirect('/account/settings')

  const [hulls, rows] = await Promise.all([getSdeTypesInGroups(HULL_PRICE_GROUP_IDS), getHullPriceRows()])
  const set = new Map(rows.map((row) => [row.type_id, row]))

  // CCP's adjusted price, as a reference only: it is a smoothed index, and for
  // these hulls it sits far from what they sell for.
  const { data: adjusted } = await sdeSupabase()
    .from('market_adjusted_price')
    .select('type_id, adjusted_price')
    .in(
      'type_id',
      hulls.map((hull) => hull.typeID)
    )
  const adjustedById = new Map(
    ((adjusted ?? []) as Array<{ type_id: number; adjusted_price: number }>).map((row) => [
      Number(row.type_id),
      Number(row.adjusted_price),
    ])
  )

  // Supercarriers first, then titans; by name within each.
  const ordered = sortWith<SdeType>([
    ascend((hull) => HULL_PRICE_GROUP_IDS.indexOf(hull.groupID)),
    ascend((hull) => hull.name),
  ])(hulls)

  return (
    <>
      <Link href="/account/settings/chancellor">&laquo; Back to Chancellor</Link>

      <h1>Hull prices</h1>
      <p>
        Supercarriers and titans sell by contract, so no market has a price for them. The price you set for a hull is
        what the ship&rsquo;s share card and the Appraise button use for it. Enter billions of ISK; leave the field
        empty to clear a price.
      </p>

      <table>
        <thead>
          <tr>
            <th>Hull</th>
            <th>Group</th>
            <th>Price</th>
            <th>Last set</th>
            <th>CCP adjusted price</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((hull) => {
            const row = set.get(hull.typeID)
            const reference = adjustedById.get(hull.typeID)
            return (
              <tr key={hull.typeID}>
                <td>{hull.name}</td>
                <td>{hull.groupName}</td>
                <td>
                  <HullPriceForm typeId={hull.typeID} price={row ? formatBisk(row.price) : ''} />
                </td>
                <td>{row ? row.updated_at.slice(0, 10) : '—'}</td>
                <td>{reference ? formatBiskUnit(reference) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

export default HullPricesPage
