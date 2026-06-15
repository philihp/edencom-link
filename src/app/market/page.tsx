import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { fetchTypeNames } from '../typeNames'
import { MarketView } from './marketView'
import type { Sale } from './recentSales'
import { LOOKBACK_DAYS } from './windows'

const PAGE_SIZE = 1000

const MarketPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.from('registration').select('id, name')
  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  const now = new Date()
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Sales over the whole lookback span — the overview's prior-period tile reaches
  // back two windows past `now`. PostgREST caps a response at max_rows (1000), so
  // page through until a short page signals the end (cf. src/jobs/assets.js).
  const sales: Sale[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from('market_transaction')
      .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at')
      .eq('is_buy', false)
      .gte('date', since)
      .order('date', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error || !page || page.length === 0) break
    sales.push(...(page as Sale[]))
    if (page.length < PAGE_SIZE) break
  }

  const typeNamesPromise = fetchTypeNames(sales.map((s) => Number(s.type_id)))

  return (
    <MarketView
      now={now.toISOString()}
      sales={sales}
      characters={sortedCharacters}
      typeNamesPromise={typeNamesPromise}
    />
  )
}
export default MarketPage
