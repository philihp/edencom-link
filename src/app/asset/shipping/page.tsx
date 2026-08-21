import type { Metadata } from 'next'
import Link from 'next/link'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'

import styles from './shipping.module.css'
import { ShippingCalculator } from './shippingCalculator'

// The action this page fires calls innomin.at through the site-wide throttle,
// where appraise() blocks polling the shared row for up to 50s
// (POLL_BUDGET_MS in src/innominate.ts). Server actions run under the route
// that invoked them, so the limit is declared here rather than inherited from
// a platform default that could truncate a queued appraisal mid-poll.
export const maxDuration = 60

export const metadata: Metadata = {
  title: 'Shipping — Edencom Link',
}

// **Deliberately public** — no gate, unlike every other page under /asset.
// Nothing here is anyone's data: the estimate is computed entirely from what
// the visitor pastes in, priced by innomin.at and quoted by kumgo.space, and
// the action reads no table at all. Signing in adds nothing to the answer, so
// requiring it only kept the alliance's haulers out of a calculator that could
// serve them.
//
// The only account lookup left decides whether to offer the way back to the
// assets browser, which IS gated — the call is request-cached and the header
// already makes it, so it costs nothing.
const ShippingPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)

  return (
    <>
      <h1>Shipping</h1>
      <p className={styles.muted}>
        Paste what you want hauled. It&apos;s appraised at Jita sell — that value is the collateral to put on the
        courier contract — and quoted both ways between Jita and C-J6.{' '}
        {user ? <Link href="/asset">Back to assets</Link> : null}
      </p>
      <ShippingCalculator />
    </>
  )
}

export default ShippingPage
