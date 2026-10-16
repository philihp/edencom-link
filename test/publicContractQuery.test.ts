// Unit coverage for the search_public_contracts seam. Pinned: a search with
// nothing narrowing it is refused, the RPC arguments clamp what the schema
// lets through, an issuer is an id or a name, and the formatter shows only
// what a contract type has (no courier items, no exchange destination) and
// says when a contract's items are not all shown.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatContract,
  idsToName,
  issuedSince,
  narrowingFilterMissing,
  parseIssuer,
  searchParams,
  type ContractRow,
  type Names,
  type ResolvedSearch,
} from '../src/app/api/mcp/publicContractQuery.ts'

const SEARCH: ResolvedSearch = {
  typeIds: null,
  regionIds: null,
  systemIds: null,
  issuerIds: null,
  contractTypes: null,
  status: 'outstanding',
  minPrice: null,
  maxPrice: null,
  issuedSince: null,
  sort: 'newest',
  limit: 50,
  itemsPerContract: 25,
}

test('a search must name an item, a place or an issuer', () => {
  assert.equal(narrowingFilterMissing(SEARCH), true)
  assert.equal(narrowingFilterMissing({ ...SEARCH, typeIds: [34] }), false)
  assert.equal(narrowingFilterMissing({ ...SEARCH, regionIds: [10000002] }), false)
  assert.equal(narrowingFilterMissing({ ...SEARCH, systemIds: [30000142] }), false)
  assert.equal(narrowingFilterMissing({ ...SEARCH, issuerIds: [98000001] }), false)
})

test('searchParams names the RPC arguments and clamps the caps', () => {
  assert.deepEqual(searchParams({ ...SEARCH, typeIds: [34], contractTypes: ['auction'], limit: 999 }), {
    type_ids: [34],
    region_ids: null,
    system_ids: null,
    issuer_ids: null,
    contract_types: ['auction'],
    status_filter: 'outstanding',
    min_price: null,
    max_price: null,
    issued_since: null,
    sort_order: 'newest',
    row_limit: 200,
    item_limit: 25,
  })
  assert.equal(searchParams({ ...SEARCH, itemsPerContract: -3 }).item_limit, 0)
})

test('issuedSince counts back whole days', () => {
  assert.equal(issuedSince(undefined, new Date('2026-10-16T00:00:00Z')), null)
  assert.equal(issuedSince(7, new Date('2026-10-16T00:00:00Z')), '2026-10-09T00:00:00.000Z')
})

test('an issuer is an id or a name', () => {
  assert.equal(parseIssuer(undefined), null)
  assert.equal(parseIssuer('  '), null)
  assert.deepEqual(parseIssuer('98000001'), { kind: 'id', id: 98000001 })
  assert.deepEqual(parseIssuer(' Goonswarm Federation '), { kind: 'name', name: 'Goonswarm Federation' })
})

const ROW: ContractRow = {
  contract_id: '1',
  type: 'item_exchange',
  status: 'outstanding',
  status_since: '2026-10-10T00:00:00Z',
  title: 'cheap trit',
  region_id: 10000002,
  start_location_id: 60003760,
  start_location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
  start_system_id: 30000142,
  end_location_id: 60003760,
  end_location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
  end_system_id: 30000142,
  issuer_id: 90000001,
  issuer_corporation_id: 98000001,
  for_corporation: false,
  price: '1000000.00',
  buyout: null,
  reward: null,
  collateral: null,
  volume: 10,
  days_to_complete: 0,
  date_issued: '2026-10-10T00:00:00Z',
  date_expired: '2026-11-10T00:00:00Z',
  items_fetched: true,
  item_lines: 3,
  items: [
    {
      type_id: 34,
      quantity: 1000,
      is_included: true,
      is_blueprint_copy: null,
      material_efficiency: null,
      time_efficiency: null,
      runs: null,
    },
    {
      type_id: 999,
      quantity: 1,
      is_included: false,
      is_blueprint_copy: true,
      material_efficiency: 10,
      time_efficiency: 20,
      runs: 5,
    },
  ],
}

const NAMES: Names = {
  types: { 34: 'Tritanium' },
  systems: { 30000142: 'Jita' },
  regions: { 10000002: 'The Forge' },
  issuers: new Map([[90000001, 'Some Pilot']]),
}

test('idsToName collects every id the formatter looks up', () => {
  assert.deepEqual(idsToName([ROW]), {
    typeIds: [34, 999],
    systemIds: [30000142],
    regionIds: [10000002],
    issuerIds: [90000001, 98000001],
  })
})

test('an item exchange shows its items, its price and a partial-items note', () => {
  assert.deepEqual(formatContract(ROW, NAMES), {
    contract_id: 1,
    type: 'item_exchange',
    status: 'outstanding',
    status_since: '2026-10-10T00:00:00Z',
    title: 'cheap trit',
    region: 'The Forge',
    from: { id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', system: 'Jita' },
    issuer: 'Some Pilot',
    issuer_corporation: '#98000001',
    price: 1000000,
    volume_m3: 10,
    date_issued: '2026-10-10T00:00:00Z',
    date_expired: '2026-11-10T00:00:00Z',
    items: [
      { item: 'Tritanium', quantity: 1000 },
      { item: 'Type #999', quantity: 1, requested: true, blueprint: 'copy', me: 10, te: 20, runs: 5 },
    ],
    items_note: 'Showing 2 of 3 item lines.',
  })
})

test('a courier shows its route and money, never items', () => {
  const courier = formatContract(
    {
      ...ROW,
      type: 'courier',
      price: null,
      reward: '3000000',
      collateral: '100000000',
      days_to_complete: 3,
      end_location_id: 1035466617946,
      end_location_name: null,
      end_system_id: null,
      items_fetched: false,
      item_lines: 0,
      items: [],
    },
    NAMES
  )
  assert.deepEqual(courier.to, { id: 1035466617946, name: 'Unknown structure #1035466617946', system: null })
  assert.equal(courier.reward, 3000000)
  assert.equal(courier.collateral, 100000000)
  assert.equal(courier.days_to_complete, 3)
  assert.equal('price' in courier, false)
  assert.equal('items' in courier, false)
  assert.equal('items_note' in courier, false)
})

test('an exchange whose items are not pulled yet says so', () => {
  const pending = formatContract({ ...ROW, items_fetched: false, item_lines: 0, items: [] }, NAMES)
  assert.deepEqual(pending.items, [])
  assert.equal(pending.items_note, 'Items not fetched yet.')
})
