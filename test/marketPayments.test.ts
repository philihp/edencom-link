// Unit coverage for the payment of a gift contract: which contracts are gifts,
// which journal entries can pay for them, the window, the nearest-first rule
// and the one-to-one claim.
import assert from 'node:assert/strict'
import test from 'node:test'

import { accountParties, contractTrades, type ContractTradeRow } from '../src/app/market/contracts.ts'
import {
  characterWallet,
  corporationWallet,
  fromCharacterJournal,
  fromCorpJournal,
  giftWallet,
  isGift,
  matchPayments,
  PAYMENT_WINDOW_MS,
  paymentNote,
  type Donation,
} from '../src/app/market/payments.ts'

const ME = 90000001
const ALT = 90000002
const CORP = 98000001 // a corporation we direct
const MEMBER_CORP = 98000002 // a corporation we are in, not a director
const BUYER = 91000001
const OTHER_BUYER = 91000002

const ours = {
  characterIds: new Set([String(ME), String(ALT)]),
  corporationIds: new Set([String(CORP), String(MEMBER_CORP)]),
}
const parties = accountParties([ME, ALT], [CORP])
const gift = isGift(ours, parties)

const ACCEPTED = '2026-11-01T12:00:00Z'
const HOUR = 60 * 60 * 1000
const at = (offsetMs: number): string => new Date(Date.parse(ACCEPTED) + offsetMs).toISOString()

const row = (over: Partial<ContractTradeRow>): ContractTradeRow => ({
  owner: { kind: 'character', registrationId: 'reg-me' },
  contract_id: 1,
  type: 'item_exchange',
  status: 'finished',
  for_corporation: false,
  issuer_id: ME,
  issuer_corporation_id: MEMBER_CORP,
  acceptor_id: BUYER,
  price: '0.00',
  reward: '0.00',
  title: null,
  start_location_id: 60003760,
  date_accepted: ACCEPTED,
  date_completed: ACCEPTED,
  seen_at: '2026-11-01T18:00:00Z',
  ...over,
})

const donation = (over: Partial<Donation>): Donation => ({
  wallet: characterWallet(ME),
  entry_id: 500,
  date: at(HOUR),
  amount: 250_000_000,
  first_party_id: BUYER,
  ...over,
})

test('PAYMENT_WINDOW_MS is 24 hours', () => {
  assert.equal(PAYMENT_WINDOW_MS, 24 * HOUR)
})

test('isGift: a zero-price exchange we issued to an outsider', () => {
  assert.equal(gift(row({})), true)
})

test('isGift: a priced exchange, a reward, an auction or an unfinished contract is not a gift', () => {
  assert.equal(gift(row({ price: '10.00' })), false)
  assert.equal(gift(row({ reward: '10.00' })), false)
  assert.equal(gift(row({ type: 'auction' })), false)
  assert.equal(gift(row({ status: 'outstanding' })), false)
  assert.equal(gift(row({ date_accepted: null })), false)
})

test('isGift: a gift to us or between two parties of the account is not a gift to match', () => {
  assert.equal(gift(row({ issuer_id: BUYER, acceptor_id: ME })), false)
  assert.equal(gift(row({ acceptor_id: ALT })), false)
  assert.equal(gift(row({ acceptor_id: CORP })), false)
  assert.equal(gift(row({ acceptor_id: null })), false)
})

test('giftWallet: the character, or the corporation for a for-corporation contract', () => {
  assert.equal(giftWallet(row({})), characterWallet(ME))
  assert.equal(giftWallet(row({ for_corporation: true })), corporationWallet(MEMBER_CORP))
})

test('matchPayments: a donation from the acceptor inside the window pays', () => {
  const paid = matchPayments([row({})], [donation({})])
  assert.deepEqual(paid.get('1'), { entry_id: 500, date: at(HOUR), amount: 250_000_000 })
})

test('matchPayments: the window edge is inside, one millisecond past it is outside', () => {
  assert.equal(matchPayments([row({})], [donation({ date: at(-PAYMENT_WINDOW_MS) })]).size, 1)
  assert.equal(matchPayments([row({})], [donation({ date: at(PAYMENT_WINDOW_MS + 1) })]).size, 0)
})

test('matchPayments: another payer, another wallet or money out does not pay', () => {
  assert.equal(matchPayments([row({})], [donation({ first_party_id: OTHER_BUYER })]).size, 0)
  assert.equal(matchPayments([row({})], [donation({ wallet: characterWallet(ALT) })]).size, 0)
  assert.equal(matchPayments([row({})], [donation({ amount: -250_000_000 })]).size, 0)
})

test('matchPayments: a for-corporation gift is paid into the corporation wallet', () => {
  const corpGift = row({ for_corporation: true })
  assert.equal(matchPayments([corpGift], [donation({})]).size, 0)
  assert.equal(matchPayments([corpGift], [donation({ wallet: corporationWallet(MEMBER_CORP) })]).size, 1)
})

test('matchPayments: the nearest entry wins', () => {
  const paid = matchPayments(
    [row({})],
    [donation({ entry_id: 1, date: at(-5 * HOUR) }), donation({ entry_id: 2, date: at(2 * HOUR) })]
  )
  assert.equal(paid.get('1')?.entry_id, 2)
})

test('matchPayments: one entry pays for one contract only', () => {
  const first = row({ contract_id: 1, date_accepted: at(0) })
  const second = row({ contract_id: 2, date_accepted: at(3 * HOUR) })
  const paid = matchPayments([first, second], [donation({ entry_id: 7, date: at(2 * HOUR) })])
  // The entry is nearer to the second contract.
  assert.deepEqual([...paid.keys()], ['2'])
})

test('matchPayments: two gifts and two entries pair nearest first', () => {
  const first = row({ contract_id: 1, date_accepted: at(0) })
  const second = row({ contract_id: 2, date_accepted: at(10 * HOUR) })
  const paid = matchPayments(
    [second, first],
    [donation({ entry_id: 20, date: at(11 * HOUR) }), donation({ entry_id: 10, date: at(HOUR) })]
  )
  assert.equal(paid.get('1')?.entry_id, 10)
  assert.equal(paid.get('2')?.entry_id, 20)
})

test('matchPayments: a tie goes to the lower entry id, whatever the input order', () => {
  const a = donation({ entry_id: 9, date: at(HOUR) })
  const b = donation({ entry_id: 8, date: at(-HOUR) })
  assert.equal(matchPayments([row({})], [a, b]).get('1')?.entry_id, 8)
  assert.equal(matchPayments([row({})], [b, a]).get('1')?.entry_id, 8)
})

test('fromCharacterJournal: maps the registration to its character wallet, drops unknowns', () => {
  const ids: Record<string, number> = { 'reg-me': ME }
  const rows = [
    { registration_id: 'reg-me', entry_id: '5', date: ACCEPTED, amount: '10.00', first_party_id: String(BUYER) },
    { registration_id: 'reg-gone', entry_id: '6', date: ACCEPTED, amount: '10.00', first_party_id: String(BUYER) },
  ]
  assert.deepEqual(fromCharacterJournal((r) => ids[r])(rows), [
    { wallet: characterWallet(ME), entry_id: 5, date: ACCEPTED, amount: 10, first_party_id: BUYER },
  ])
})

test('fromCorpJournal: the corporation wallet, whatever the division', () => {
  const rows = [{ corporation_id: String(CORP), entry_id: 5, date: ACCEPTED, amount: 10, first_party_id: BUYER }]
  assert.deepEqual(fromCorpJournal(rows), [
    { wallet: corporationWallet(CORP), entry_id: 5, date: ACCEPTED, amount: 10, first_party_id: BUYER },
  ])
})

test('contractTrades: a paid gift is a sale at the donation amount, with its entry', () => {
  const gifts = [row({})]
  const payments = matchPayments(gifts, [donation({})])
  const [t] = contractTrades({ ours, parties, items: new Map(), payments })(gifts)
  assert.equal(t.side, 'sell')
  assert.equal(t.client_id, BUYER)
  assert.equal(t.unit_price, 250_000_000)
  assert.equal(t.registration_id, 'reg-me')
  assert.deepEqual(t.payment, { entry_id: 500, date: at(HOUR), amount: 250_000_000 })
})

test('contractTrades: an unpaid gift is not a trade', () => {
  assert.deepEqual(contractTrades({ ours, parties, items: new Map(), payments: new Map() })([row({})]), [])
})

test('paymentNote: names the entry, the amount and the UTC time', () => {
  assert.equal(
    paymentNote({ entry_id: 500, date: '2026-11-01T13:04:05.000Z', amount: 250_000_000 }),
    '≈ value inferred: paid by journal entry #500, a player donation of 250,000,000 ISK on 2026-11-01 13:04 UTC'
  )
})
