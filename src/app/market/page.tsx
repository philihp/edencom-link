import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { fetchTypeNames } from '../typeNames'
import { RecentSales } from './recentSales'

const MarketPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.from('registration').select('id, name')

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: sales } = await supabase
    .from('market_transaction')
    .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at')
    .eq('is_buy', false)
    .gte('date', sevenDaysAgo)
    .order('date', { ascending: false })

  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  const typeNamesPromise = fetchTypeNames((sales ?? []).map((s) => Number(s.type_id)))

  return (
    <>
      <h1>Market</h1>
      <RecentSales sales={sales ?? []} characters={sortedCharacters} typeNamesPromise={typeNamesPromise} />
    </>
  )
}
export default MarketPage
