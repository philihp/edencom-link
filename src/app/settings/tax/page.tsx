import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { COST_AVOIDANCE_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { fetchTaxRates } from './rates'
import TaxForm from './taxForm'
import styles from './tax.module.css'

// Dark-launched behind cost-avoidance, like /graphql and /item/[itemId]: an
// account without the flag gets a 404 rather than a locked page.
const TaxRatesPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }
  if (!(await hasFlag(user.id, COST_AVOIDANCE_FLAG))) notFound()

  const rates = await fetchTaxRates(supabase, user.id)

  return (
    <>
      <Link href="/account/settings">&laquo; Back to settings</Link>

      <h1>Industry Tax Rates</h1>

      <p className={styles.intro}>
        A structure&rsquo;s industry tax is set in the client, and CCP publishes it nowhere: no ESI endpoint carries it,
        and the request to expose it has been open since 2016. So the two rates below are declared rather than
        extracted. Structures uses them to work out the <strong>cost avoidance</strong> on jobs your own characters
        installed in your own structures &mdash; the tax bill you never incurred by not renting somebody else&rsquo;s
        slots.
      </p>

      <TaxForm rates={rates} />
    </>
  )
}

export default TaxRatesPage
