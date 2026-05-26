import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { RecentSales, type Sale } from './recentSales'

const ESI_TRANSACTION_LIMIT = 2500

const MarketPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters } = await supabase.schema('hangar').from('character').select('id, name')

  const perCharacterSales = await Promise.all(
    (characters ?? []).map(async (c) => {
      const { data: rows } = await supabase
        .schema('hangar')
        .from('market_transaction')
        .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at, is_buy')
        .eq('character_id', c.id)
        .order('date', { ascending: false })
        .limit(ESI_TRANSACTION_LIMIT)
      return rows ?? []
    })
  )

  const sales: Sale[] = perCharacterSales
    .flat()
    .filter((s) => !s.is_buy)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const characterName: Record<string, string> = Object.fromEntries(characters?.map((c) => [c.id, c.name]) ?? [])

  return (
    <>
      <h1>Market</h1>
      <RecentSales sales={sales} characterName={characterName} />
    </>
  )
}
export default MarketPage
