import { redirect } from 'next/navigation'
import { splitEvery, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { fetchDirectorships, type DirectorGrant } from '../structure/directors'
import { fetchTypeNames } from '../typeNames'
import {
  accountParties,
  CONTRACT_COLUMNS,
  contractTrades,
  FINISHED,
  itemsByContract,
  oneRowPerContract,
  TRADE_KINDS,
  type ContractTradeRow,
} from './contracts'
import { MarketView } from './marketView'
import { fetchAllRows, type BuildPage } from './pager'
import {
  fromCharacterJournal,
  fromCorpJournal,
  isGift,
  JOURNAL_COLUMNS,
  matchPayments,
  PAYMENT_WINDOW_MS,
  PLAYER_DONATION,
} from './payments'
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

// Ids per universe_name .in() request, so that the request URL stays short.
const NAME_CHUNK = 200

type Supabase = Awaited<ReturnType<typeof createClient>>
type Num = number | string
type ContractViewRow = Omit<ContractTradeRow, 'owner'>
type CharacterContractRow = ContractViewRow & { registration_id: string }
type CorpContractRow = ContractViewRow & { corporation_id: Num }
type ContractItemRow = { contract_id: Num; record_id: Num; type_id: Num; quantity: Num }
type JournalRow = { entry_id: Num; date: string; amount: Num | null; first_party_id: Num | null }
type CharacterJournalRow = JournalRow & { registration_id: string }
type CorpJournalRow = JournalRow & { corporation_id: Num; division: Num }
type Registration = { id: string; name: string; character_id: Num; corporation_id: Num | null }

// Contract ids per item .in() request, so that the request URL stays short.
const CONTRACT_CHUNK = 200

// The included items of some contracts, from one item table. RLS scopes the
// rows the same way as the contracts.
const fetchContractItems = async (
  supabase: Supabase,
  table: 'character_contract_item' | 'corp_contract_item',
  contractIds: number[]
): Promise<ContractItemRow[]> => {
  const chunks = await Promise.all(
    splitEvery(CONTRACT_CHUNK, contractIds).map((chunk) =>
      fetchAllRows<ContractItemRow>(
        (from, to, count) =>
          supabase
            .from(table)
            .select('contract_id, record_id, type_id, quantity', { count })
            .eq('is_included', true)
            .in('contract_id', chunk)
            .order('contract_id')
            .order('record_id')
            .range(from, to),
        (r) => String(r.record_id)
      )
    )
  )
  return chunks.flat()
}

type UniverseName = { name: string; category: string }

// id → name and category from universe_name (the universe-names job keeps it
// populated). An id that universe_name does not know is not in the record; the
// UI then shows the raw id.
const fetchUniverseNames = async (supabase: Supabase, ids: number[]): Promise<Record<number, UniverseName>> => {
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

// The ids that label trades: our corporations, and the counterparties.
const corpIdsOf = (trades: Trade[]) => uniq(trades.flatMap((t) => (t.corporation_id == null ? [] : [t.corporation_id])))
const nameIdsOf = (trades: Trade[]) => uniq([...corpIdsOf(trades), ...trades.map((t) => t.client_id)])

// The market trades: both wallet transaction tables over the lookback.
//
// The overview's prior-period tile reaches back two windows past `now`, so fetch
// the whole lookback span. Personal and corp trades live in separate tables (corp
// transactions have no owning character); RLS scopes each to what the user may
// see, and transaction_ids never collide across the two, so the union is a plain
// concatenation. ESI's character wallet/transactions endpoint also reports trades
// the character made on behalf of their corp (is_personal: false) — those are
// already captured via corp_wallet_transaction, so exclude them here to avoid
// counting the same trade two times. Both sides (buys and sells) are read.
const loadMarketTrades = async (supabase: Supabase, since: string): Promise<Trade[]> => {
  const personal: BuildPage<CharacterTransactionRow> = (from, to, count) =>
    supabase
      .from('character_wallet_transaction')
      .select(`registration_id, ${TRADE_COLUMNS}`, { count })
      .eq('is_personal', true)
      .gte('date', since)
      .order('date', { ascending: false })
      .order('transaction_id', { ascending: false })
      .range(from, to)
  const corp: BuildPage<CorpTransactionRow> = (from, to, count) =>
    supabase
      .from('corp_wallet_transaction')
      .select(`corporation_id, ${TRADE_COLUMNS}`, { count })
      .gte('date', since)
      .order('date', { ascending: false })
      .order('transaction_id', { ascending: false })
      .range(from, to)
  const byId = (r: { transaction_id: Num }) => String(r.transaction_id)
  const [personalRows, corpRows] = await Promise.all([fetchAllRows(personal, byId), fetchAllRows(corp, byId)])
  return [...personalRows.map(fromCharacterRow), ...corpRows.map(fromCorpRow)]
}

// The contract trades: finished item exchanges and auctions accepted in the
// lookback (contracts.ts), with their items and, for a gift, the donation
// that paid for it (payments.ts). This chain does not wait for the market
// trades.
const loadContractTrades = async (
  supabase: Supabase,
  since: string,
  registrations: Registration[],
  directorships: DirectorGrant[]
): Promise<Trade[]> => {
  const [characterContracts, corpContracts] = await Promise.all([
    fetchAllRows<CharacterContractRow>(
      (from, to, count) =>
        supabase
          .from('character_contract_with_status')
          .select(`registration_id, ${CONTRACT_COLUMNS}`, { count })
          .eq('status', FINISHED)
          .in('type', TRADE_KINDS)
          .gte('date_accepted', since)
          .order('registration_id')
          .order('contract_id')
          .range(from, to),
      (r) => `${r.registration_id}:${r.contract_id}`
    ),
    fetchAllRows<CorpContractRow>(
      (from, to, count) =>
        supabase
          .from('corp_contract_with_status')
          .select(`corporation_id, ${CONTRACT_COLUMNS}`, { count })
          .eq('status', FINISHED)
          .in('type', TRADE_KINDS)
          .gte('date_accepted', since)
          .order('corporation_id')
          .order('contract_id')
          .range(from, to),
      (r) => `${r.corporation_id}:${r.contract_id}`
    ),
  ])

  // A contract is internal (not a trade) when both parties are in the account:
  // its characters and the corporations it directs.
  const characterIds = registrations.map((r) => r.character_id)
  const contractRows: ContractTradeRow[] = [
    ...characterContracts.map(({ registration_id, ...r }) => ({
      ...r,
      owner: { kind: 'character' as const, registrationId: registration_id },
    })),
    ...corpContracts.map(({ corporation_id, ...r }) => ({
      ...r,
      owner: { kind: 'corporation' as const, corporationId: Number(corporation_id) },
    })),
  ]
  const ourCorporationIds = uniq([
    ...registrations.flatMap((r) => (r.corporation_id == null ? [] : [String(r.corporation_id)])),
    ...corpContracts.map((r) => String(r.corporation_id)),
  ])
  const ours = {
    characterIds: new Set(characterIds.map(String)),
    corporationIds: new Set(ourCorporationIds),
  }
  const parties = accountParties(
    characterIds,
    directorships.map((d) => d.corporationId)
  )
  // A gift (a zero-price exchange to an outsider) is a sale when a
  // player_donation from the acceptor paid for it (payments.ts). Read the
  // donations into our wallets for the lookback, plus the window before it.
  // RLS scopes both journals to the wallets the user may see.
  const gifts = oneRowPerContract(contractRows).filter(isGift(ours, parties))
  const journalSince = new Date(Date.parse(since) - PAYMENT_WINDOW_MS).toISOString()
  const characterIdByRegistration = new Map(registrations.map((r) => [r.id, r.character_id]))
  const characterIdOf = (registrationId: string): Num | undefined => characterIdByRegistration.get(registrationId)
  const contractIdsOf = (rows: { contract_id: Num }[]) => uniq(rows.map((r) => Number(r.contract_id)))
  const [characterItems, corpItems, characterJournal, corpJournal] = await Promise.all([
    fetchContractItems(supabase, 'character_contract_item', contractIdsOf(characterContracts)),
    fetchContractItems(supabase, 'corp_contract_item', contractIdsOf(corpContracts)),
    gifts.length === 0
      ? []
      : fetchAllRows<CharacterJournalRow>(
          (from, to, count) =>
            supabase
              .from('character_wallet_journal')
              .select(`registration_id, ${JOURNAL_COLUMNS}`, { count })
              .eq('ref_type', PLAYER_DONATION)
              .gt('amount', 0)
              .gte('date', journalSince)
              .order('registration_id')
              .order('entry_id')
              .range(from, to),
          (r) => `${r.registration_id}:${r.entry_id}`
        ),
    gifts.length === 0
      ? []
      : fetchAllRows<CorpJournalRow>(
          (from, to, count) =>
            supabase
              .from('corp_wallet_journal')
              .select(`corporation_id, division, ${JOURNAL_COLUMNS}`, { count })
              .eq('ref_type', PLAYER_DONATION)
              .gt('amount', 0)
              .gte('date', journalSince)
              .order('corporation_id')
              .order('division')
              .order('entry_id')
              .range(from, to),
          (r) => `${r.corporation_id}:${r.division}:${r.entry_id}`
        ),
  ])
  const payments = matchPayments(gifts, [
    ...fromCharacterJournal(characterIdOf)(characterJournal),
    ...fromCorpJournal(corpJournal),
  ])
  // A contract seen by a character and by a corporation has the same items in
  // both tables; keep one copy of each contract's list.
  const items = new Map([...itemsByContract(corpItems), ...itemsByContract(characterItems)])
  return contractTrades({ ours, parties, items, payments })(contractRows)
}

// The page waits on two independent chains, not one long waterfall:
//   market trades (2 round trips) → their names
//   registrations → contracts → items and donations → the names that are new
// Each chain starts its name read when its own trades arrive.
const MarketPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const now = new Date()
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const marketChain = loadMarketTrades(supabase, since).then(async (trades) => ({
    trades,
    names: await fetchUniverseNames(supabase, nameIdsOf(trades)),
  }))

  const registrationsPromise = supabase
    .from('registration')
    .select('id, name, character_id, corporation_id')
    .then(({ data }) => (data ?? []) as Registration[])

  const contractChain = Promise.all([registrationsPromise, fetchDirectorships(supabase)])
    .then(([registrations, directorships]) => loadContractTrades(supabase, since, registrations, directorships))
    .then(async (trades) => ({ trades, ids: nameIdsOf(trades) }))

  const [registrations, market, contract] = await Promise.all([registrationsPromise, marketChain, contractChain])
  // Read only the contract names that the market chain did not read.
  const contractNames = await fetchUniverseNames(
    supabase,
    contract.ids.filter((id) => !(id in market.names))
  )
  const names = { ...market.names, ...contractNames }

  const sortedCharacters = [...registrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }))

  const trades: Trade[] = [...market.trades, ...contract.trades]

  // Corporation names label corp trades; counterparty names label the other
  // side of each trade.
  const corpIds = corpIdsOf(trades)
  const clientIds = uniq(trades.map((t) => t.client_id))
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

  // Market trades name one type each; a contract row names its items.
  const typeNamesPromise = fetchTypeNames(
    uniq(trades.flatMap((t) => (t.contract === null ? [t.type_id] : t.contract.items.map((i) => i.type_id))))
  )

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
