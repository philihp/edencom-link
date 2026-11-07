import { chain, filter, map, pipe, reduce, sortWith, ascend } from 'ramda'

import { formatIsk } from '../isk.ts'
import { contractSide, type OurIds } from '../api/graphql/contracts.ts'
import { FINISHED, isInternal, type ContractTradeRow } from './contracts.ts'

// The payment for a gift contract. Pure: the page reads the contracts and the
// wallet journals, and these functions match them.
//
// A player often sells items with an item exchange at zero price, and the
// buyer then sends the ISK as a direct transfer. EVE writes that transfer in
// the wallet journal as a `player_donation`, not as a wallet transaction.
//
// Rules:
// - A gift is a finished item exchange with zero price and zero reward. One of
//   our characters issued it (or issued it for one of our corporations) to an
//   acceptor outside the account (see `isInternal`).
// - A payment is a `player_donation` journal entry in the wallet of the
//   issuer: the character wallet, or the corporation wallet when the contract
//   is for the corporation. Its first party is the acceptor, and its amount is
//   more than zero (money came in).
// - The entry must be within PAYMENT_WINDOW_MS of `date_accepted`.
// - The nearest entry in time wins. One entry pays for one contract at most,
//   and one contract has one payment at most.
// - A gift with no payment is not a sale.

// How far from the acceptance a payment can be: 24 hours on each side.
export const PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000

export const PLAYER_DONATION = 'player_donation'

type Num = number | string

// The wallet that a journal entry is in, or that a contract pays into:
// 'character:<EVE character id>' or 'corporation:<corporation id>'.
export type WalletKey = string

export const characterWallet = (characterId: Num): WalletKey => `character:${characterId}`
export const corporationWallet = (corporationId: Num): WalletKey => `corporation:${corporationId}`

// One player_donation entry, as the page reads it from either journal.
export type Donation = {
  wallet: WalletKey
  entry_id: number
  date: string
  amount: number
  first_party_id: number
}

// The journal entry that paid for a gift. The trade shows it in the hover.
export type Payment = {
  entry_id: number
  date: string
  amount: number
}

const isZero = (v: Num | null | undefined): boolean => Number(v ?? 0) === 0

// The wallet a gift is paid into: the issuer's corporation for a
// for-corporation contract, else the issuing character.
export const giftWallet = (row: ContractTradeRow): WalletKey | null => {
  if (row.for_corporation)
    return row.issuer_corporation_id == null ? null : corporationWallet(row.issuer_corporation_id)
  return row.issuer_id == null ? null : characterWallet(row.issuer_id)
}

// True when the row is a gift from us to an outside party (see the rules).
export const isGift =
  (ours: OurIds, parties: ReadonlySet<string>) =>
  (row: ContractTradeRow): boolean =>
    row.status === FINISHED &&
    row.type === 'item_exchange' &&
    isZero(row.price) &&
    isZero(row.reward) &&
    row.acceptor_id != null &&
    row.date_accepted != null &&
    contractSide(row, ours) === 'issuer' &&
    !isInternal(parties)(row) &&
    giftWallet(row) !== null

// One possible match: a gift, a donation, and the time between them.
type Candidate = { contractId: string; donation: Donation; gap: number }

const entryKey = (d: Donation): string => `${d.wallet}:${d.entry_id}`

// Every donation that can pay for this gift: same wallet, from the acceptor,
// money in, and inside the window.
const candidatesOf =
  (donations: Donation[]) =>
  (row: ContractTradeRow): Candidate[] => {
    const wallet = giftWallet(row)
    const accepted = Date.parse(row.date_accepted as string)
    const acceptor = Number(row.acceptor_id)
    return pipe(
      filter((d: Donation) => d.wallet === wallet && d.first_party_id === acceptor && d.amount > 0),
      map((d: Donation) => ({
        contractId: String(row.contract_id),
        donation: d,
        gap: Math.abs(Date.parse(d.date) - accepted),
      })),
      filter((c: Candidate) => c.gap <= PAYMENT_WINDOW_MS)
    )(donations)
  }

// Nearest first. A tie goes to the lower entry id, then the lower contract
// id, so that the result does not change with the order of the input.
const byNearest = sortWith<Candidate>([
  ascend((c) => c.gap),
  ascend((c) => c.donation.entry_id),
  ascend((c) => c.contractId),
])

type Claim = { payments: Map<string, Payment>; used: Set<string> }

// Take the candidates nearest first. A candidate whose contract is already
// paid, or whose entry is already used, is skipped. The Map and the Set are
// the accumulator, so the fold stays O(n).
const claim = (acc: Claim, c: Candidate): Claim => {
  const key = entryKey(c.donation)
  if (acc.payments.has(c.contractId) || acc.used.has(key)) return acc
  acc.used.add(key)
  acc.payments.set(c.contractId, { entry_id: c.donation.entry_id, date: c.donation.date, amount: c.donation.amount })
  return acc
}

// contract id → the entry that paid for it. A gift with no match has no key.
export const matchPayments = (gifts: ContractTradeRow[], donations: Donation[]): Map<string, Payment> =>
  reduce<Candidate, Claim>(
    claim,
    { payments: new Map<string, Payment>(), used: new Set<string>() },
    byNearest(chain(candidatesOf(donations), gifts))
  ).payments

type JournalRow = { entry_id: Num; date: string; amount: Num | null; first_party_id: Num | null }

const donation = (wallet: WalletKey, r: JournalRow): Donation => ({
  wallet,
  entry_id: Number(r.entry_id),
  date: r.date,
  amount: Number(r.amount ?? 0),
  first_party_id: Number(r.first_party_id ?? 0),
})

// A character journal row as a donation. `characterIdOf` maps the row's
// registration uuid to its EVE character id; a row it cannot map is dropped.
export const fromCharacterJournal =
  (characterIdOf: (registrationId: string) => Num | undefined) =>
  (rows: (JournalRow & { registration_id: string })[]): Donation[] =>
    chain((r) => {
      const characterId = characterIdOf(r.registration_id)
      return characterId === undefined ? [] : [donation(characterWallet(characterId), r)]
    }, rows)

// A corporation journal row as a donation. The division does not matter.
export const fromCorpJournal = (rows: (JournalRow & { corporation_id: Num })[]): Donation[] =>
  map((r) => donation(corporationWallet(r.corporation_id), r), rows)

export const JOURNAL_COLUMNS = 'entry_id, date, amount, first_party_id'

// The hover text of an inferred value: which journal entry paid for the gift.
// The time is UTC, so the server and the browser show the same text.
export const paymentNote = (p: Payment): string =>
  `≈ value inferred: paid by journal entry #${p.entry_id}, a player donation of ${formatIsk(p.amount)} on ${p.date.slice(0, 16).replace('T', ' ')} UTC`
