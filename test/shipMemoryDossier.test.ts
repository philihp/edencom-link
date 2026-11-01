// Unit coverage for the ship dossier fold (src/app/ship/memory/dossier.ts,
// docs/ship-memory.md "What the ship knows"). Pinned hardest: the origin
// inference, whose windows and rule order are the whole of recall_ship's
// "where it came from"; then the chain folds (stops, names, owners), pilots,
// cargo at-least counting, fuel fill and refit counting.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cargo,
  dossier,
  fit,
  fuel,
  isHoldFlag,
  isSlotFlag,
  itinerary,
  nameSpans,
  origin,
  pilots,
  predatesRecord,
  RECORD_START_SLACK_MS,
  tenures,
  type ChildVersion,
  type DossierInput,
  type HullVersion,
  type Owner,
} from '../src/app/ship/memory/dossier.ts'

const HOUR = 60 * 60 * 1000
const T0 = new Date('2026-09-01T00:00:00Z').getTime()
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString()

const ALT_A: Owner = { kind: 'character', id: 'reg-a' }
const ALT_B: Owner = { kind: 'character', id: 'reg-b' }
const CORP: Owner = { kind: 'corporation', id: '98000001' }
const RENS = { id: 60004588, type: 'station' }
const HEK = { id: 60005686, type: 'station' }

const hullAt = (over: Partial<HullVersion> = {}): HullVersion => ({
  owner: ALT_A,
  typeId: 653, // Wreathe
  name: 'Rusty Kettle',
  place: RENS,
  parentId: null,
  isCurrent: false,
  validFrom: at(0),
  validUntil: at(6),
  ...over,
})

const child = (over: Partial<ChildVersion> & Pick<ChildVersion, 'itemId' | 'typeId' | 'flag'>): ChildVersion => ({
  quantity: 1,
  isCurrent: false,
  validFrom: at(0),
  validUntil: at(6),
  ...over,
})

const WINDOW = 6 * HOUR

const input = (over: Partial<DossierInput> = {}): DossierInput => ({
  itemId: 1_000_000_001,
  hull: [hullAt({ validFrom: at(24), validUntil: at(30) }), hullAt({ validFrom: at(30), isCurrent: true })],
  children: [],
  boardings: [],
  jobs: [],
  contracts: [],
  buys: [],
  stacks: [],
  recordStart: at(0),
  lastSeen: at(100),
  volumeOf: () => undefined,
  fuelBayCapacity: null,
  extractIntervalMs: WINDOW,
  ...over,
})

const DEBUT = { at: at(24), owner: ALT_A, place: RENS }

// ── origin ────────────────────────────────────────────────────────────────

test('a hull debuting in the owner’s first extract predates the record, whatever else matches', () => {
  const o = origin(
    input({ recordStart: at(24), jobs: [{ jobId: 1, owner: ALT_A, runs: 1, endDate: at(23), status: 'delivered' }] }),
    DEBUT
  )
  assert.equal(o.kind, 'predates_record')
  assert.equal(predatesRecord(at(24), at(24)), true)
  assert.equal(predatesRecord(at(24), new Date(T0 + 24 * HOUR + RECORD_START_SLACK_MS).toISOString()), true)
  assert.equal(predatesRecord(at(24), new Date(T0 + 24 * HOUR + RECORD_START_SLACK_MS + 1).toISOString()), false)
  assert.equal(predatesRecord(null, at(24)), false)
})

test('one delivered manufacturing job of the type inside the window is a confident build', () => {
  const o = origin(input({ jobs: [{ jobId: 7, owner: ALT_B, runs: 1, endDate: at(20), status: 'delivered' }] }), DEBUT)
  assert.equal(o.kind, 'built')
  if (o.kind !== 'built') return
  assert.equal(o.jobId, 7)
  assert.equal(o.confidence, 'high')
  assert.deepEqual(o.owner, ALT_B)
})

test('the window is one extract interval before the debut, inclusive at both ends', () => {
  const job = (endDate: string) => ({ jobId: 1, owner: ALT_A, runs: 1, endDate, status: 'delivered' })
  assert.equal(origin(input({ jobs: [job(at(18))] }), DEBUT).kind, 'built')
  assert.equal(origin(input({ jobs: [job(at(24))] }), DEBUT).kind, 'built')
  assert.equal(origin(input({ jobs: [job(new Date(T0 + 18 * HOUR - 1).toISOString())] }), DEBUT).kind, 'unknown')
  assert.equal(origin(input({ jobs: [job(at(25))] }), DEBUT).kind, 'unknown')
})

test('two jobs in the window: the nearest is picked with medium confidence and both are counted', () => {
  const o = origin(
    input({
      jobs: [
        { jobId: 1, owner: ALT_A, runs: 1, endDate: at(19), status: 'delivered' },
        { jobId: 2, owner: ALT_A, runs: 1, endDate: at(22), status: 'delivered' },
      ],
    }),
    DEBUT
  )
  assert.equal(o.kind, 'built')
  if (o.kind !== 'built') return
  assert.equal(o.jobId, 2)
  assert.equal(o.confidence, 'medium')
  assert.equal(o.candidates, 2)
})

test('a cancelled or reverted job builds nothing', () => {
  const o = origin(input({ jobs: [{ jobId: 1, owner: ALT_A, runs: 1, endDate: at(22), status: 'cancelled' }] }), DEBUT)
  assert.equal(o.kind, 'unknown')
})

test('rules run in the plan’s order: a job beats a contract beats a buy beats a stack', () => {
  const contract = { contractId: 5, owner: ALT_A, kind: 'item_exchange', status: 'finished', at: at(23), quantity: 1 }
  const buy = { transactionId: 9, owner: ALT_A, date: at(23), quantity: 1, unitPrice: 1_000_000 }
  const stack = {
    itemId: 42,
    owner: ALT_A,
    place: RENS,
    quantity: 3,
    isCurrent: false,
    validFrom: at(0),
    validUntil: at(23),
  }
  const job = { jobId: 1, owner: ALT_A, runs: 1, endDate: at(22), status: 'delivered' }
  assert.equal(origin(input({ jobs: [job], contracts: [contract], buys: [buy], stacks: [stack] }), DEBUT).kind, 'built')
  assert.equal(origin(input({ contracts: [contract], buys: [buy], stacks: [stack] }), DEBUT).kind, 'contracted')
  assert.equal(origin(input({ buys: [buy], stacks: [stack] }), DEBUT).kind, 'bought')
  assert.equal(origin(input({ stacks: [stack] }), DEBUT).kind, 'reassembled')
})

test('only an item exchange or auction can bring a hull; a courier never does', () => {
  const courier = { contractId: 5, owner: ALT_A, kind: 'courier', status: 'finished', at: at(23), quantity: 1 }
  const auction = { contractId: 6, owner: ALT_A, kind: 'auction', status: 'finished', at: at(23), quantity: 1 }
  assert.equal(origin(input({ contracts: [courier] }), DEBUT).kind, 'unknown')
  const o = origin(input({ contracts: [auction] }), DEBUT)
  assert.equal(o.kind, 'contracted')
  if (o.kind === 'contracted') assert.equal(o.contractKind, 'auction')
})

test('a packaged stack counts only at the same place under the same owner, and only if it shrank', () => {
  const base = { itemId: 42, quantity: 3, isCurrent: false, validFrom: at(0), validUntil: at(23) }
  // Same owner and place, no successor: the stack vanished into the hull.
  assert.equal(origin(input({ stacks: [{ ...base, owner: ALT_A, place: RENS }] }), DEBUT).kind, 'reassembled')
  // A successor one smaller: one was assembled.
  assert.equal(
    origin(
      input({
        stacks: [
          { ...base, owner: ALT_A, place: RENS },
          { ...base, owner: ALT_A, place: RENS, quantity: 2, validFrom: at(23), isCurrent: true },
        ],
      }),
      DEBUT
    ).kind,
    'reassembled'
  )
  // A successor the same size: a repack, not an assembly.
  assert.equal(
    origin(
      input({
        stacks: [
          { ...base, owner: ALT_A, place: RENS },
          { ...base, owner: ALT_A, place: RENS, quantity: 3, validFrom: at(23), isCurrent: true },
        ],
      }),
      DEBUT
    ).kind,
    'unknown'
  )
  // Another alt's stack, or a stack at Hek, is someone else's business.
  assert.equal(origin(input({ stacks: [{ ...base, owner: ALT_B, place: RENS }] }), DEBUT).kind, 'unknown')
  assert.equal(origin(input({ stacks: [{ ...base, owner: ALT_A, place: HEK }] }), DEBUT).kind, 'unknown')
})

test('nothing in the window is an unknown past, said in so many words', () => {
  const o = origin(input(), DEBUT)
  assert.equal(o.kind, 'unknown')
  if (o.kind === 'unknown') assert.match(o.note, /no known past/)
})

// ── the chain ─────────────────────────────────────────────────────────────

test('consecutive versions at one place are one stop; the open stop runs to the last sighting', () => {
  const hull = [
    hullAt({ validFrom: at(0), validUntil: at(6) }),
    hullAt({ validFrom: at(6), validUntil: at(12), name: 'Rusty Kettle II' }), // a rename, same place
    hullAt({ validFrom: at(12), validUntil: at(18), place: HEK }),
    hullAt({ validFrom: at(18), validUntil: at(18), place: RENS, isCurrent: true }),
  ]
  const stops = itinerary(hull, at(30))
  assert.deepEqual(
    stops.map((s) => [s.place?.id, s.arrived, s.departed, s.hours]),
    [
      [RENS.id, at(0), at(12), 12],
      [HEK.id, at(12), at(18), 6],
      [RENS.id, at(18), null, 12],
    ]
  )
})

test('a hull inside another item is a stop at no place, aboard that parent', () => {
  const stops = itinerary([hullAt({ place: null, parentId: 777, isCurrent: true })], at(6))
  assert.equal(stops.length, 1)
  assert.equal(stops[0].place, null)
  assert.equal(stops[0].parentId, 777)
})

test('name spans and owner tenures collapse the same way, and a hand-over between alts is one chain', () => {
  const hull = [
    hullAt({ validFrom: at(0), validUntil: at(6) }),
    hullAt({ validFrom: at(6), validUntil: at(12), owner: ALT_B }),
    hullAt({ validFrom: at(12), validUntil: at(12), owner: ALT_B, name: 'Kettle', isCurrent: true }),
  ]
  assert.deepEqual(tenures(hull), [
    { owner: ALT_A, from: at(0), until: at(6) },
    { owner: ALT_B, from: at(6), until: null },
  ])
  assert.deepEqual(nameSpans(hull), [
    { name: 'Rusty Kettle', from: at(0), until: at(12) },
    { name: 'Kettle', from: at(12), until: null },
  ])
})

// ── pilots ────────────────────────────────────────────────────────────────

test('pilots: boardings per character, hours summed, the open boarding runs to the last sighting', () => {
  const rows = [
    { registrationId: 'reg-a', isCurrent: false, validFrom: at(0), validUntil: at(2) },
    { registrationId: 'reg-b', isCurrent: false, validFrom: at(3), validUntil: at(4) },
    { registrationId: 'reg-a', isCurrent: true, validFrom: at(5), validUntil: at(5) },
  ]
  assert.deepEqual(pilots(rows, at(8)), [
    { registrationId: 'reg-a', boardings: 2, first: at(0), last: null, hours: 5 },
    { registrationId: 'reg-b', boardings: 1, first: at(3), last: at(4), hours: 1 },
  ])
})

// ── cargo ─────────────────────────────────────────────────────────────────

test('hold flags: cargo, fleet hangar and specialised holds; not slots, drones, fighters, ships or fuel', () => {
  assert.equal(isHoldFlag('Cargo'), true)
  assert.equal(isHoldFlag('FleetHangar'), true)
  assert.equal(isHoldFlag('SpecializedOreHold'), true)
  assert.equal(isHoldFlag('SpecializedFuelBay'), false)
  assert.equal(isHoldFlag('DroneBay'), false)
  assert.equal(isHoldFlag('ShipHangar'), false)
  assert.equal(isHoldFlag('HiSlot0'), false)
  assert.equal(isHoldFlag(null), false)
  assert.equal(isSlotFlag('SubSystemSlot1'), true)
  assert.equal(isSlotFlag('RigSlot2'), true)
  assert.equal(isSlotFlag('Cargo'), false)
})

test('cargo counts each item once at its largest quantity, adds stacks of one type, and never skips a volume', () => {
  const TRIT = 34
  const QUAFE = 3699
  const children = [
    child({ itemId: 1, typeId: TRIT, flag: 'Cargo', quantity: 1000, validFrom: at(0), validUntil: at(6) }),
    child({ itemId: 1, typeId: TRIT, flag: 'Cargo', quantity: 4000, validFrom: at(6), validUntil: at(12) }),
    child({ itemId: 1, typeId: TRIT, flag: 'Cargo', quantity: 2000, validFrom: at(12), isCurrent: true }),
    child({ itemId: 2, typeId: TRIT, flag: 'Cargo', quantity: 500 }),
    child({ itemId: 3, typeId: QUAFE, flag: 'Cargo', quantity: 10 }),
    child({ itemId: 4, typeId: 2048, flag: 'LoSlot0' }), // a module, not cargo
  ]
  const c = cargo(children, (typeId) => (typeId === TRIT ? 0.01 : undefined))
  assert.equal(c.distinctTypes, 2)
  assert.deepEqual(c.lines[0], { typeId: TRIT, maxQuantity: 4500, volume: 45 })
  assert.deepEqual(c.lines[1], { typeId: QUAFE, maxQuantity: 10, volume: null })
  // Quafe has no volume in this mirror, so the total is unknown, not 45.
  assert.equal(c.volumeAtLeast, null)
  assert.equal(cargo(children.slice(0, 4), () => 0.01).volumeAtLeast, 45)
})

// ── fuel ──────────────────────────────────────────────────────────────────

test('fuel: no bay, no section; a bay never stocked is reported empty', () => {
  assert.equal(
    fuel([], null, () => 5, at(10)),
    null
  )
  assert.equal(
    fuel([], 0, () => 5, at(10)),
    null
  )
  assert.deepEqual(
    fuel([], 10000, () => 5, at(10)),
    {
      fuelTypeId: null,
      capacity: 10000,
      meanFill: null,
      lowestFill: null,
      highestFill: null,
      samples: 0,
    }
  )
})

test('fuel fill is time-weighted and stacks at one moment add up', () => {
  const BLOCK = 4247 // Nitrogen Fuel Block, 5 m³
  const children = [
    // Full for 6h, then half for 2h (the open row runs to the last sighting).
    child({
      itemId: 1,
      typeId: BLOCK,
      flag: 'SpecializedFuelBay',
      quantity: 1000,
      validFrom: at(0),
      validUntil: at(6),
    }),
    child({ itemId: 1, typeId: BLOCK, flag: 'SpecializedFuelBay', quantity: 500, validFrom: at(6), isCurrent: true }),
    // A second stack aboard for the first 6h as well.
    child({
      itemId: 2,
      typeId: BLOCK,
      flag: 'SpecializedFuelBay',
      quantity: 1000,
      validFrom: at(0),
      validUntil: at(6),
    }),
  ]
  const f = fuel(children, 10000, () => 5, at(8))
  assert.ok(f)
  assert.equal(f.fuelTypeId, BLOCK)
  // 1.0 fill for 6h, 0.25 for 2h → (6 + 0.5) / 8
  assert.ok(Math.abs((f.meanFill ?? 0) - 6.5 / 8) < 1e-9)
  assert.equal(f.lowestFill, 0.25)
  assert.equal(f.highestFill, 1)
  assert.equal(f.samples, 2)
})

// ── fit ───────────────────────────────────────────────────────────────────

test('refits count distinct consecutive fits; the current fit is in fitting-window order', () => {
  const children = [
    child({ itemId: 1, typeId: 2048, flag: 'LoSlot0', validFrom: at(0), isCurrent: true }), // Damage Control II, all along
    child({ itemId: 2, typeId: 3841, flag: 'HiSlot0', validFrom: at(0), validUntil: at(6) }), // a gun, swapped out
    child({ itemId: 3, typeId: 3842, flag: 'HiSlot0', validFrom: at(6), isCurrent: true }), // for another
    child({ itemId: 4, typeId: 34, flag: 'Cargo', validFrom: at(6), isCurrent: true }), // cargo is not a fit change
  ]
  const f = fit(children, at(12))
  assert.deepEqual(
    f.current.map((l) => [l.flag, l.typeId]),
    [
      ['HiSlot0', 3842],
      ['LoSlot0', 2048],
    ]
  )
  assert.equal(f.fitsSeen, 2)
  assert.equal(f.refits, 1)
  assert.deepEqual(fit([], at(1)), { current: [], fitsSeen: 0, refits: 0 })
})

// ── the whole ─────────────────────────────────────────────────────────────

test('dossier: null for a hull never held; otherwise the debut is the earliest version across owners', () => {
  assert.equal(dossier(input({ hull: [] })), null)
  const d = dossier(
    input({
      hull: [
        hullAt({ owner: CORP, validFrom: at(10), validUntil: at(24) }),
        hullAt({ validFrom: at(24), validUntil: at(24), isCurrent: true }),
      ],
    })
  )
  assert.ok(d)
  assert.deepEqual(d.debut.owner, CORP)
  assert.equal(d.debut.at, at(10))
  assert.equal(d.debut.predatesRecord, false)
  assert.equal(d.inHangar, true)
  assert.equal(d.lastSeen, at(100))
  assert.equal(d.versions, 2)
  assert.equal(d.tenures.length, 2)
})
