import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { RecentSales } from './recentSales'

const MarketPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.schema('hangar').from('character').select('id, name')

  // eslint-disable-next-line react-hooks/purity
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: sales } = await supabase
    .schema('hangar')
    .from('market_transaction')
    .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at')
    .eq('is_buy', false)
    .gte('date', sevenDaysAgo)
    .order('date', { ascending: false })

  const characterName: Record<string, string> = Object.fromEntries(characters?.map((c) => [c.id, c.name]) ?? [])

  return (
    <>
      <h1>Market</h1>
      <RecentSales sales={sales ?? []} characterName={characterName} />
    </>
  )
}
export default MarketPage
