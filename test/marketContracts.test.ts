// Unit coverage for the contract trades on the market page: which contracts
// are trades, which are internal to the account, which row of a contract
// counts, and the shape of the trade.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountParties,
  contractLabel,
  contractTrade,
  contractTrades,
  isInternal,
  issuerParty,
  itemsByContract,
  oneRowPerContract,
  type ContractTradeRow,
} from '../src/app/market/contracts.ts'

const ME = 90000001 // our character
const ALT = 90000002 // our other character
const CORP = 98000001 // a corporation we direct
const MEMBER_CORP = 98000002 // a corporation we are in, not a director
const STRANGER = 91000001
const STRANGER_CORP = 98500001

const ours = {
  characterIds: new Set([String(ME), String(ALT)]),
  corporationIds: new Set([String(CORP), String(MEMBER_CORP)]),
}
const parties = accountParties([ME, ALT], [CORP])
const items = itemsByContract([
  { contract_id: '1', type_id: '34', quantity: '100' },
  { contract_id: '1', type_id: 35, quantity: 5 },
])
const input = { ours, parties, items }

const row = (over: Partial<ContractTradeRow>): ContractTradeRow => ({
  owner: { kind: 'character', registrationId: 'reg-me' },
  contract_id: 1,
  type: 'item_exchange',
  status: 'finished',
  for_corporation: false,
  issuer_id: ME,
  issuer_corporation_id: MEMBER_CORP,
  acceptor_id: STRANGER,
  price: '1000000.00',
  reward: '0.00',
  title: null,
  start_location_id: 60003760,
  date_accepted: '2026-11-01T00:00:00Z',
  date_completed: '2026-11-01T01:00:00Z',
  seen_at: '2026-11-01T02:00:00Z',
  ...over,
})

test('issuerParty is the corporation of a for-corporation contract', () => {
  assert.equal(issuerParty(row({})), String(ME))
  assert.equal(issuerParty(row({ for_corporation: true })), String(MEMBER_CORP))
})

test('isInternal: two of our characters', () => {
  assert.equal(isInternal(parties)(row({ acceptor_id: ALT })), true)
})

test('isInternal: our character and a corporation we direct, both ways', () => {
  assert.equal(isInternal(parties)(row({ acceptor_id: CORP })), true)
  assert.equal(isInternal(parties)(row({ for_corporation: true, issuer_corporation_id: CORP, acceptor_id: ALT })), true)
})

test('isInternal: a corporation we only belong to is not in the account', () => {
  assert.equal(isInternal(parties)(row({ acceptor_id: MEMBER_CORP })), false)
})

test('isInternal: a stranger is never internal', () => {
  assert.equal(isInternal(parties)(row({})), false)
  assert.equal(isInternal(parties)(row({ issuer_id: STRANGER, acceptor_id: ME })), false)
})

test('isInternal: an unaccepted contract is not internal', () => {
  assert.equal(isInternal(parties)(row({ acceptor_id: null })), false)
})

test('contractTrade: we issued, a stranger paid the price: a sale to the stranger', () => {
  const t = contractTrade(input)(row({}))
  assert.deepEqual(t, {
    source: 'contract',
    transaction_id: 1,
    side: 'sell',
    registration_id: 'reg-me',
    corporation_id: null,
    client_id: STRANGER,
    location_id: 60003760,
    date: '2026-11-01T01:00:00Z',
    type_id: 0,
    quantity: 1,
    unit_price: 1_000_000,
    seen_at: '2026-11-01T02:00:00Z',
    contract: {
      title: null,
      items: [
        { type_id: 34, quantity: 100 },
        { type_id: 35, quantity: 5 },
      ],
    },
    payment: null,
  })
})

test('contractTrade: we accepted a stranger’s exchange: a purchase from the stranger', () => {
  const t = contractTrade(input)(row({ issuer_id: STRANGER, issuer_corporation_id: STRANGER_CORP, acceptor_id: ME }))
  assert.equal(t?.side, 'buy')
  assert.equal(t?.client_id, STRANGER)
  assert.equal(t?.unit_price, 1_000_000)
})

test('contractTrade: the counterparty of a for-corporation issue is the corporation', () => {
  const t = contractTrade(input)(
    row({ issuer_id: STRANGER, issuer_corporation_id: STRANGER_CORP, for_corporation: true, acceptor_id: ME })
  )
  assert.equal(t?.client_id, STRANGER_CORP)
})

test('contractTrade: a want-to-buy we issued is a purchase for the reward', () => {
  const t = contractTrade(input)(row({ price: 0, reward: '250000' }))
  assert.equal(t?.side, 'buy')
  assert.equal(t?.unit_price, 250_000)
})

test('contractTrade: a for-corporation issue uses the corporation wallet', () => {
  const t = contractTrade(input)(row({ for_corporation: true }))
  assert.equal(t?.registration_id, null)
  assert.equal(t?.corporation_id, MEMBER_CORP)
})

test('contractTrade: a corporation acceptor uses the corporation wallet', () => {
  const t = contractTrade(input)(
    row({
      owner: { kind: 'corporation', corporationId: MEMBER_CORP },
      issuer_id: STRANGER,
      issuer_corporation_id: STRANGER_CORP,
      acceptor_id: MEMBER_CORP,
    })
  )
  assert.equal(t?.side, 'buy')
  assert.equal(t?.corporation_id, MEMBER_CORP)
  assert.equal(t?.registration_id, null)
})

test('contractTrade: no date_completed falls back to date_accepted', () => {
  assert.equal(contractTrade(input)(row({ date_completed: null }))?.date, '2026-11-01T00:00:00Z')
})

test('contractTrade: the title is kept, an empty title is null', () => {
  assert.equal(contractTrade(input)(row({ title: 'ore' }))?.contract?.title, 'ore')
  assert.equal(contractTrade(input)(row({ title: '' }))?.contract?.title, null)
})

test('contractTrade: an auction is a trade', () => {
  assert.equal(contractTrade(input)(row({ type: 'auction' }))?.side, 'sell')
})

test('contractTrade: not a trade', () => {
  const none = (over: Partial<ContractTradeRow>) =>
    assert.equal(contractTrade(input)(row(over)), null, JSON.stringify(over))
  none({ status: 'outstanding' })
  none({ status: 'expired' })
  none({ status: null })
  none({ type: 'courier' })
  none({ type: 'loan' })
  none({ price: 0, reward: 0 }) // a gift
  none({ acceptor_id: ALT }) // internal
  none({ acceptor_id: CORP }) // internal
  none({ issuer_id: STRANGER, issuer_corporation_id: STRANGER_CORP, acceptor_id: 91000002 }) // not ours
  none({ date_accepted: null, date_completed: null })
})

test('oneRowPerContract: a character contract keeps the character row', () => {
  const kept = oneRowPerContract([
    row({ owner: { kind: 'corporation', corporationId: MEMBER_CORP } }),
    row({ owner: { kind: 'character', registrationId: 'reg-me' } }),
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].owner.kind, 'character')
})

test('oneRowPerContract: a for-corporation contract keeps the corporation row', () => {
  const kept = oneRowPerContract([
    row({ for_corporation: true, owner: { kind: 'character', registrationId: 'reg-me' } }),
    row({ for_corporation: true, owner: { kind: 'corporation', corporationId: MEMBER_CORP } }),
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].owner.kind, 'corporation')
})

test('oneRowPerContract: a lone row is kept, different contracts stay apart', () => {
  const kept = oneRowPerContract([
    row({ contract_id: 1, owner: { kind: 'corporation', corporationId: MEMBER_CORP } }),
    row({ contract_id: '2' }),
  ])
  assert.equal(kept.length, 2)
})

test('contractTrades: one trade per contract, internal contracts dropped', () => {
  const trades = contractTrades(input)([
    row({ contract_id: 1 }),
    row({ contract_id: 1, owner: { kind: 'corporation', corporationId: MEMBER_CORP } }),
    row({ contract_id: 2, acceptor_id: ALT }),
    row({ contract_id: 3, type: 'courier' }),
  ])
  assert.deepEqual(
    trades.map((t) => t.transaction_id),
    [1]
  )
  assert.equal(trades[0].registration_id, 'reg-me')
})

test('contractLabel counts the item lines', () => {
  assert.equal(contractLabel([]), 'Contract · 0 items')
  assert.equal(contractLabel([{ type_id: 34, quantity: 9 }]), 'Contract · 1 item')
  assert.equal(contractLabel(items.get('1')!), 'Contract · 2 items')
})
