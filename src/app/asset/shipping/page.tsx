import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

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

// Static except for the auth gate — everything the page shows comes from the
// action the textarea fires, so there is nothing to fetch on the way in.
const ShippingPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  return (
    <>
      <h1>Shipping</h1>
      <p className={styles.muted}>
        Paste what you want hauled. It&apos;s appraised at Jita sell — that value is the collateral to put on the
        courier contract — and quoted both ways between Jita and C-J6. <Link href="/asset">Back to assets</Link>
      </p>
      <ShippingCalculator />
    </>
  )
}

export default ShippingPage
