// The contract filters and, mostly, the one thing ESI does not store: which
// way the ISK went (src/app/api/graphql/contracts.ts).
//
// A contract names an issuer, an acceptor, a price and a reward, from nobody's
// point of view. "Did I buy or sell this" is the whole reason to search
// contracts, so these are the cases that decide it.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contractDirection,
  contractSide,
  matchKindFilter,
  parseDirectionFilter,
  summariseItems,
  type ContractRow,
  type OurIds,
} from '../src/app/api/graphql/contracts.ts'

const US = '90000001'
const OUR_CORP = '98000001'
const THEM = '90000999'
const THEIR_CORP = '98000999'

const ours: OurIds = { characterIds: new Set([US]), corporationIds: new Set([OUR_CORP]) }

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  type: 'item_exchange',
  for_corporation: false,
  issuer_id: THEM,
  issuer_corporation_id: THEIR_CORP,
  acceptor_id: null,
  price: 0,
  reward: 0,
  ...over,
})

test('we are the issuer when one of our characters made it', () => {
  assert.equal(contractSide(contract({ issuer_id: US }), ours), 'issuer')
})

test('we are the issuer when it was made for one of our corporations', () => {
  // for_corporation is what says the ISK lands in the corp wallet, so a
  // corpmate's contract on the corp's behalf is ours to account for.
  const row = contract({ issuer_id: THEM, issuer_corporation_id: OUR_CORP, for_corporation: true })
  assert.equal(contractSide(row, ours), 'issuer')
  // Without the flag it is that character's own contract, not our corp's.
  assert.equal(contractSide({ ...row, for_corporation: false }, ours), null)
})

test('we are the acceptor whether we took it as a character or a corporation', () => {
  assert.equal(contractSide(contract({ acceptor_id: US }), ours), 'acceptor')
  assert.equal(contractSide(contract({ acceptor_id: OUR_CORP }), ours), 'acceptor')
})

test('a contract touching neither of us has no side', () => {
  // A corp contract is visible to every member whether or not they touched it.
  assert.equal(contractSide(contract({ acceptor_id: THEM }), ours), null)
})

test('issuing an item exchange for a price is a sale', () => {
  assert.equal(contractDirection(contract({ issuer_id: US, price: 5_000_000 }), ours), 'sold')
})

test('accepting that same contract is a purchase', () => {
  assert.equal(contractDirection(contract({ acceptor_id: US, price: 5_000_000 }), ours), 'bought')
})

test('a want-to-buy contract is a PURCHASE for its issuer', () => {
  // The reward column runs the other way: the issuer pays it. Assuming the
  // issuer always sells would file every want-to-buy as a sale, which is why
  // direction reads the ISK rather than the role.
  const wtb = contract({ issuer_id: US, price: 0, reward: 5_000_000 })
  assert.equal(contractDirection(wtb, ours), 'bought')
  assert.equal(contractDirection({ ...wtb, issuer_id: THEM, acceptor_id: US }, ours), 'sold')
})

test('a courier is neither, however much its reward is', () => {
  // Its reward is a hauling fee. Reading it as a purchase would file every
  // shipment as something bought — a wrong answer a saved report repeats.
  const courier = contract({ type: 'courier', issuer_id: US, reward: 20_000_000 })
  assert.equal(contractDirection(courier, ours), 'neither')
  assert.equal(contractDirection({ ...courier, issuer_id: THEM, acceptor_id: US }, ours), 'neither')
})

test('a loan is neither', () => {
  assert.equal(contractDirection(contract({ type: 'loan', issuer_id: US, price: 1_000_000 }), ours), 'neither')
})

test('an auction is a trade like an item exchange', () => {
  assert.equal(contractDirection(contract({ type: 'auction', issuer_id: US, price: 900_000 }), ours), 'sold')
})

test('a gift moves no ISK, so it is neither', () => {
  assert.equal(contractDirection(contract({ issuer_id: US, price: 0, reward: 0 }), ours), 'neither')
})

test('a contract neither of us touched is neither', () => {
  assert.equal(contractDirection(contract({ price: 5_000_000 }), ours), 'neither')
})

test('null and unparseable money read as zero rather than throwing', () => {
  assert.equal(contractDirection(contract({ issuer_id: US, price: null, reward: null }), ours), 'neither')
  assert.equal(contractDirection(contract({ issuer_id: US, price: '7500000.50' }), ours), 'sold')
})

test('parseDirectionFilter takes the vocabulary and refuses the rest', () => {
  assert.deepEqual(parseDirectionFilter('bought'), { ok: true, direction: 'bought' })
  assert.deepEqual(parseDirectionFilter(' SOLD '), { ok: true, direction: 'sold' })
  assert.deepEqual(parseDirectionFilter(null), { ok: true, direction: null })
  assert.deepEqual(parseDirectionFilter('  '), { ok: true, direction: null })
  const bad = parseDirectionFilter('purchases')
  assert.ok(!bad.ok)
  assert.match(bad.message, /Available: bought, sold, neither/)
})

test('the kind filter searches on the singular and takes exact entries on the plural', () => {
  const search = matchKindFilter('exchange', null)
  assert.ok(search.ok)
  assert.deepEqual(search.kinds, ['item_exchange'])

  const exact = matchKindFilter(null, ['Courier', 'AUCTION'])
  assert.ok(exact.ok)
  assert.deepEqual(exact.kinds, ['courier', 'auction'])

  // The column stores CCP's raw token, so an unrecognised exact entry is a
  // legitimate ask — a kind we have never seen is not a typo to refuse.
  const unknown = matchKindFilter(null, ['some_new_thing'])
  assert.ok(unknown.ok)
  assert.deepEqual(unknown.kinds, ['some_new_thing'])

  const noMatch = matchKindFilter('nonsense', null)
  assert.ok(!noMatch.ok)
  assert.match(noMatch.message, /No contract kind matched/)

  const both = matchKindFilter('courier', ['loan'])
  assert.ok(!both.ok)
  assert.match(both.message, /kind or kinds/)
})

test('the item summary names what was included, stacking repeats', () => {
  const name = (id: number | string) => ({ '34': 'Tritanium', '587': 'Rifter' })[String(id)] ?? null
  const summary = summariseItems(
    [
      { type_id: 34, quantity: 1000, is_included: true },
      { type_id: 34, quantity: 500, is_included: true },
      { type_id: 587, quantity: 1, is_included: true },
    ],
    name
  )
  assert.equal(summary, '1,500 × Tritanium, 1 × Rifter')
})

test('the item summary leaves out what the issuer ASKED for', () => {
  // An item exchange lists both sides; folding them together would read as one
  // basket and make a purchase look like it included what you paid with.
  const name = () => 'Tritanium'
  assert.equal(summariseItems([{ type_id: 34, quantity: 5, is_included: false }], name), null)
  assert.equal(
    summariseItems(
      [
        { type_id: 34, quantity: 5, is_included: true },
        { type_id: 34, quantity: 99, is_included: false },
      ],
      name
    ),
    '5 × Tritanium'
  )
})

test('a long summary is capped and says how much it left out', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ type_id: i + 1, quantity: 1, is_included: true }))
  const summary = summariseItems(items, (id) => `Type ${id}`) ?? ''
  assert.match(summary, /and 3 more$/)
  assert.equal(summary.startsWith('1 × Type 1,'), true)
})

test('an unnamed type still appears, by id', () => {
  assert.equal(
    summariseItems([{ type_id: 99999, quantity: 2, is_included: true }], () => null),
    '2 × #99999'
  )
})

test('no items at all is null, not an empty string', () => {
  assert.equal(
    summariseItems([], () => 'x'),
    null
  )
})
