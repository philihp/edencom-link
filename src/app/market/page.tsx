import { redirect } from 'next/navigation'
import { splitEvery, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { fetchTypeNames } from '../typeNames'
import { MarketView } from './marketView'
import { parseKind } from './shares'
import {
  fromCharacterRow,
  fromCorpRow,
  TRADE_COLUMNS,
  type CharacterTransactionRow,
  type CorpTransactionRow,
  type Trade,
} from './trade'
import { LOOKBACK_DAYS } from './windows'

const PAGE_SIZE = 1000
// Ids per universe_name .in() request, so that the request URL stays short.
const NAME_CHUNK = 200

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>

// Page through a select past PostgREST's max_rows (1000) cap until a short page
// signals the end (cf. src/jobs/characterAssets.js). Tail-recursive; the
// accumulator is push-mutated so that the copy is O(n), not O(n^2).
const fetchAllRows = async <T,>(
  build: (from: number, to: number) => PageResult<T>,
  from = 0,
  acc: T[] = []
): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data) return acc
  acc.push(...data)
  return data.length < PAGE_SIZE ? acc : fetchAllRows(build, from + PAGE_SIZE, acc)
}

type UniverseName = { name: string; category: string }

// id → name and category from universe_name (the universe-names job keeps it
// populated). An id that universe_name does not know is not in the record; the
// UI then shows the raw id.
const fetchUniverseNames = async (
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: number[]
): Promise<Record<number, UniverseName>> => {
  const chunks = await Promise.all(
    splitEvery(NAME_CHUNK, ids).map(async (chunk) => {
      const { data } = await supabase.from('universe_name').select('id, name, category').in('id', chunk)
      return (data ?? []).map(
        (r) => [Number(r.id), { name: r.name as string, category: r.category as string }] as const
      )
    })
  )
  return Object.fromEntries(chunks.flat())
}

const MarketPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const { data: characters } = await supabase.from('registration').select('id, name')
  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  const now = new Date()
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // The overview's prior-period tile reaches back two windows past `now`, so fetch
  // the whole lookback span. Personal and corp trades live in separate tables (corp
  // transactions have no owning character); RLS scopes each to what the user may
  // see, and transaction_ids never collide across the two, so the union is a plain
  // concatenation. ESI's character wallet/transactions endpoint also reports trades
  // the character made on behalf of their corp (is_personal: false) — those are
  // already captured via corp_wallet_transaction, so exclude them here to avoid
  // counting the same trade two times. Both sides (buys and sells) are read.
  const [personalRows, corpRows] = await Promise.all([
    fetchAllRows<CharacterTransactionRow>((from, to) =>
      supabase
        .from('character_wallet_transaction')
        .select(`registration_id, ${TRADE_COLUMNS}`)
        .eq('is_personal', true)
        .gte('date', since)
        .order('date', { ascending: false })
        .order('transaction_id', { ascending: false })
        .range(from, to)
    ),
    fetchAllRows<CorpTransactionRow>((from, to) =>
      supabase
        .from('corp_wallet_transaction')
        .select(`corporation_id, ${TRADE_COLUMNS}`)
        .gte('date', since)
        .order('date', { ascending: false })
        .order('transaction_id', { ascending: false })
        .range(from, to)
    ),
  ])

  const trades: Trade[] = [...personalRows.map(fromCharacterRow), ...corpRows.map(fromCorpRow)]

  // Corporation names label corp trades; counterparty names label the other
  // side of each trade. One universe_name read serves both.
  const corpIds = uniq(trades.flatMap((t) => (t.corporation_id == null ? [] : [t.corporation_id])))
  const clientIds = uniq(trades.map((t) => t.client_id))
  const names = await fetchUniverseNames(supabase, uniq([...corpIds, ...clientIds]))
  const pickNames = (ids: number[]) =>
    Object.fromEntries(ids.flatMap((id) => (id in names ? [[id, names[id].name]] : [])))
  // character, corporation or alliance per counterparty, so the tile can show
  // the right image. An id of another or unknown kind is not in the record.
  const counterpartyKinds = Object.fromEntries(
    clientIds.flatMap((id) => {
      const kind = id in names ? parseKind(names[id].category) : undefined
      return kind === undefined ? [] : [[id, kind]]
    })
  )

  const typeNamesPromise = fetchTypeNames(trades.map((t) => t.type_id))

  return (
    <MarketView
      now={now.toISOString()}
      trades={trades}
      characters={sortedCharacters}
      corpNames={pickNames(corpIds)}
      counterpartyNames={pickNames(clientIds)}
      counterpartyKinds={counterpartyKinds}
      typeNamesPromise={typeNamesPromise}
    />
  )
}
export default MarketPage
