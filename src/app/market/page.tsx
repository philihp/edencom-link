import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { fetchTypeNames } from '../typeNames'
import { MarketView } from './marketView'
import type { Sale } from './recentSales'
import { LOOKBACK_DAYS } from './windows'

const PAGE_SIZE = 1000

// Page through a select past PostgREST's max_rows (1000) cap until a short page
// signals the end (cf. src/jobs/assets.js).
const fetchAllRows = async <T,>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> => {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error || !data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

type CorpRow = {
  transaction_id: number | string
  corporation_id: number | string
  date: string
  type_id: number | string
  quantity: number | string
  unit_price: number | string
  seen_at: string
}

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

  // The overview's prior-period tile reaches back two windows past `now`, so fetch
  // the whole lookback span. Personal and corp sales live in separate tables (corp
  // transactions have no owning character); RLS scopes each to what the user may
  // see, and transaction_ids never collide across the two, so the union is a plain
  // concatenation. ESI's character wallet/transactions endpoint also reports trades
  // the character made on behalf of their corp (is_personal: false) — those are
  // already captured via corp_market_transaction, so exclude them here to avoid
  // double-counting the same sale.
  const personal = await fetchAllRows<Sale>((from, to) =>
    supabase
      .from('market_transaction')
      .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at')
      .eq('is_buy', false)
      .eq('is_personal', true)
      .gte('date', since)
      .order('date', { ascending: false })
      .range(from, to)
  )

  const corpRows = await fetchAllRows<CorpRow>((from, to) =>
    supabase
      .from('corp_market_transaction')
      .select('transaction_id, corporation_id, date, type_id, quantity, unit_price, seen_at')
      .eq('is_buy', false)
      .gte('date', since)
      .order('date', { ascending: false })
      .range(from, to)
  )

  const corpSales: Sale[] = corpRows.map((r) => ({
    transaction_id: r.transaction_id,
    character_id: null,
    corporation_id: r.corporation_id,
    date: r.date,
    type_id: r.type_id,
    quantity: r.quantity,
    unit_price: r.unit_price,
    seen_at: r.seen_at,
  }))

  const sales: Sale[] = [...personal, ...corpSales]

  // Resolve corp names from eve_name (kept populated by the hourly job) to label
  // corp sales; unresolved ids fall back to a raw id in the table.
  const corpIds = [...new Set(corpSales.map((s) => Number(s.corporation_id)))]
  let corpNames: Record<number, string> = {}
  if (corpIds.length > 0) {
    const { data: nameRows } = await supabase.from('eve_name').select('id, name').in('id', corpIds)
    corpNames = Object.fromEntries((nameRows ?? []).map((r) => [Number(r.id), r.name as string]))
  }

  const typeNamesPromise = fetchTypeNames(sales.map((s) => Number(s.type_id)))

  return (
    <MarketView
      now={now.toISOString()}
      sales={sales}
      characters={sortedCharacters}
      corpNames={corpNames}
      typeNamesPromise={typeNamesPromise}
    />
  )
}
export default MarketPage
