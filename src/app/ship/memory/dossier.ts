// What a ship knows about itself, as facts (docs/ship-memory.md, "What the
// ship knows"). A pure fold over rows the extracts already write: the hull's
// own version chain, the versions of everything that has ever been inside it,
// who has boarded it, and the jobs, contracts, buys and packaged stacks of its
// type around the moment it first appeared. It produces facts only, never
// prose: the AI that reads them over MCP writes the memory in the ship's own
// voice. No I/O; the loader (load.ts) reads the rows and names the ids.
//
// Everything here is sampled. The extracts list a hangar every 6h for a
// character and daily for a corporation, so a stop, a cargo or a pilot held
// between two runs is invisible, and every figure is an "at least" figure.
// The origin is inferred, not recorded: no table links an output item to the
// job, contract or transaction that produced it, so the match is "same type,
// just before the debut", and it is reported with its evidence and a
// confidence rather than as a fact.
import { ascend, groupBy, sortBy, sortWith, uniq } from 'ramda'

import { flagSortKey } from '../../fitting/fit.ts'

export type OwnerKind = 'character' | 'corporation'

// A registration uuid for a character, a corporation id for a corporation —
// the convention every asset table and the web pages share.
export type Owner = { kind: OwnerKind; id: string }

export type Place = { id: number; type: string | null }

// One version of the hull itself. The place is the root location the owner's
// place table carries (null when the hull sits inside another item, or when
// the row is one the caller only sees through a share); parentId is that
// other item when there is one.
export type HullVersion = {
  owner: Owner
  typeId: number
  name: string | null
  place: Place | null
  parentId: number | null
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

// One version of an item whose location was the hull: a fitted module, a
// charge, a drone, a crate in the cargo hold.
export type ChildVersion = {
  itemId: number
  typeId: number
  flag: string | null
  quantity: number
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

// One character_ship_over_time row naming the hull: a boarding.
export type BoardingRow = {
  registrationId: string
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

export type JobCandidate = { jobId: number; owner: Owner; runs: number; endDate: string; status: string }
export type ContractCandidate = {
  contractId: number
  owner: Owner
  kind: string
  status: string | null
  // The moment the hull could have changed hands: completion, else acceptance.
  at: string | null
  quantity: number
}
export type BuyCandidate = { transactionId: number; owner: Owner; date: string; quantity: number; unitPrice: number }
// A packaged stack of the hull's type under one of the caller's owners.
export type StackVersion = {
  itemId: number
  owner: Owner
  place: Place | null
  quantity: number
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

// One hop of the ship's lineage (docs/ship-memory.md "Reassembly"): the item
// id this hull's memory was carried from when it was assembled, and when.
// Nearest first. The loader has already folded those hulls' versions into
// `hull`, `children` and `boardings`, so the itinerary covers the ship's
// whole life; this is the list of ids it ran under.
export type LineageLink = { itemId: number; carriedAt: string }

export type DossierInput = {
  itemId: number
  // The earlier item ids this hull's memory came through, nearest first;
  // empty for a hull that was never reassembled.
  lineage: LineageLink[]
  hull: HullVersion[]
  children: ChildVersion[]
  boardings: BoardingRow[]
  jobs: JobCandidate[]
  contracts: ContractCandidate[]
  buys: BuyCandidate[]
  stacks: StackVersion[]
  // The earliest valid_from of any asset row under the debut's owner: the
  // first extract wrote every item at once, so a hull whose debut is that run
  // was already in the hangar and predates our record.
  recordStart: string | null
  // When the hull was last seen (lastSeen.ts): the close of an open row's
  // interval, since an open row's own valid_until is only its debut.
  lastSeen: string
  // m³ per unit, from the SDE; undefined when the mirror has none.
  volumeOf: (typeId: number) => number | undefined
  // The hull's fuel bay in m³ (dogma specialFuelBayCapacity); null when the
  // hull has none.
  fuelBayCapacity: number | null
  // How long one extract interval is for the debut's owner: the origin match
  // looks this far back before the debut.
  extractIntervalMs: number
}

export type Confidence = 'high' | 'medium' | 'low'

export type Origin =
  | { kind: 'predates_record'; at: string; note: string }
  | { kind: 'built'; at: string; confidence: Confidence; jobId: number; owner: Owner; runs: number; candidates: number }
  | {
      kind: 'contracted'
      at: string
      confidence: Confidence
      contractId: number
      owner: Owner
      contractKind: string
      candidates: number
    }
  | {
      kind: 'bought'
      at: string
      confidence: Confidence
      transactionId: number
      owner: Owner
      unitPrice: number
      candidates: number
    }
  | { kind: 'reassembled'; at: string; confidence: Confidence; stackItemId: number; owner: Owner; candidates: number }
  | { kind: 'unknown'; at: string; note: string }

export type Stop = {
  place: Place | null
  parentId: number | null
  arrived: string
  departed: string | null
  hours: number
}
export type Tenure = { owner: Owner; from: string; until: string | null }
export type NameSpan = { name: string | null; from: string; until: string | null }
export type Pilot = { registrationId: string; boardings: number; first: string; last: string | null; hours: number }
export type CargoLine = { typeId: number; maxQuantity: number; volume: number | null }
export type Cargo = { lines: CargoLine[]; volumeAtLeast: number | null; distinctTypes: number }
export type Fuel = {
  fuelTypeId: number | null
  capacity: number
  meanFill: number | null
  lowestFill: number | null
  highestFill: number | null
  samples: number
}
export type FitLine = { flag: string; typeId: number; quantity: number }
export type Fit = { current: FitLine[]; fitsSeen: number; refits: number }

export type Dossier = {
  itemId: number
  lineage: LineageLink[]
  typeId: number
  names: NameSpan[]
  debut: { at: string; owner: Owner; place: Place | null; predatesRecord: boolean }
  origin: Origin
  tenures: Tenure[]
  itinerary: Stop[]
  pilots: Pilot[]
  cargo: Cargo
  fuel: Fuel | null
  fit: Fit
  inHangar: boolean
  lastSeen: string
  versions: number
}

// Within an hour of the owner's first extract, the hull was already there.
export const RECORD_START_SLACK_MS = 60 * 60 * 1000

const ms = (iso: string): number => new Date(iso).getTime()
const hoursBetween = (from: string, until: string): number => Math.max(0, (ms(until) - ms(from)) / 3_600_000)

const byValidFrom = <T extends { validFrom: string }>(rows: T[]): T[] => sortBy((r) => ms(r.validFrom), rows)

// When a version stopped holding: its close, or for the open row the last
// sighting (an open row's own valid_until is its debut and means nothing).
const endOf = (row: { isCurrent: boolean; validUntil: string }, lastSeen: string): string =>
  row.isCurrent ? lastSeen : row.validUntil

const samePlace = (a: Place | null, b: Place | null): boolean => a === b || (a != null && b != null && a.id === b.id)
const sameOwner = (a: Owner, b: Owner): boolean => a.kind === b.kind && a.id === b.id

// ── slots and holds ───────────────────────────────────────────────────────

const SLOT_PREFIXES = ['HiSlot', 'MedSlot', 'LoSlot', 'RigSlot', 'SubSystemSlot']
export const isSlotFlag = (flag: string | null): flag is string =>
  flag != null && SLOT_PREFIXES.some((prefix) => flag.startsWith(prefix))

export const FUEL_FLAG = 'SpecializedFuelBay'

// What the ship *carried*, as against what it fitted or launched: the cargo
// hold, the fleet hangar and every specialised hold, less the fuel bay (its
// own section) and the drone, fighter and ship bays (a drone is crew, not
// cargo, and a ship in a maintenance bay has a dossier of its own).
export const isHoldFlag = (flag: string | null): flag is string =>
  flag != null && flag !== FUEL_FLAG && (flag === 'Cargo' || flag === 'FleetHangar' || flag.startsWith('Specialized'))

// ── the chain ─────────────────────────────────────────────────────────────

// Consecutive versions that agree on a key collapse into one span. The span
// ends at the close of its last version, or stays open on the current row.
const spans = <T, K>(
  rows: T[],
  keyOf: (row: T) => K,
  same: (a: K, b: K) => boolean,
  from: (row: T) => string,
  until: (row: T) => string | null
): Array<{ key: K; from: string; until: string | null; rows: T[] }> =>
  rows.reduce<Array<{ key: K; from: string; until: string | null; rows: T[] }>>((acc, row) => {
    const last = acc[acc.length - 1]
    const key = keyOf(row)
    if (last && same(last.key, key)) {
      last.until = until(row)
      last.rows.push(row)
    } else acc.push({ key, from: from(row), until: until(row), rows: [row] })
    return acc
  }, [])

// A closed version's close; the open row has none yet.
const closeOf = (row: HullVersion): string | null => (row.isCurrent ? null : row.validUntil)

export const nameSpans = (hull: HullVersion[]): NameSpan[] =>
  spans(
    byValidFrom(hull),
    (v) => v.name,
    (a, b) => a === b,
    (v) => v.validFrom,
    closeOf
  ).map(({ key, from, until }) => ({ name: key, from, until }))

export const tenures = (hull: HullVersion[]): Tenure[] =>
  spans(
    byValidFrom(hull),
    (v) => v.owner,
    sameOwner,
    (v) => v.validFrom,
    closeOf
  ).map(({ key, from, until }) => ({ owner: key, from, until }))

// Where it has docked: consecutive versions at one place are one stop, with
// the dwell measured from the first version's open to the last one's close
// (or to the last sighting while the hull is still there). A hull inside
// another item (a carrier's maintenance bay) is a stop at no place, aboard
// that parent.
export const itinerary = (hull: HullVersion[], lastSeen: string): Stop[] =>
  spans(
    byValidFrom(hull),
    (v) => ({ place: v.place, parentId: v.parentId }),
    (a, b) => samePlace(a.place, b.place) && a.parentId === b.parentId,
    (v) => v.validFrom,
    closeOf
  ).map(({ key, from, until }) => ({
    place: key.place,
    parentId: key.parentId,
    arrived: from,
    departed: until,
    hours: hoursBetween(from, until ?? lastSeen),
  }))

// ── who has flown it ──────────────────────────────────────────────────────

export const pilots = (boardings: BoardingRow[], lastSeen: string): Pilot[] =>
  Object.entries(groupBy((b: BoardingRow) => b.registrationId, byValidFrom(boardings)))
    .map(([registrationId, rows = []]) => {
      const last = rows[rows.length - 1]
      return {
        registrationId,
        boardings: rows.length,
        first: rows[0].validFrom,
        last: last.isCurrent ? null : last.validUntil,
        hours: rows.reduce((total, b) => total + hoursBetween(b.validFrom, endOf(b, lastSeen)), 0),
      }
    })
    .sort((a, b) => ms(a.first) - ms(b.first))

// ── what it has carried ───────────────────────────────────────────────────

// Each child item id counts once, at the largest quantity ever seen aboard:
// the same crate listed by forty extracts is one crate. Lines of one type
// then add up, so two stacks of Tritanium in the hold are one line. Volume
// is null when a type has no volume in the SDE, never silently skipped.
export const cargo = (children: ChildVersion[], volumeOf: (typeId: number) => number | undefined): Cargo => {
  const held = children.filter((c) => isHoldFlag(c.flag))
  const maxByItem = held.reduce<Map<number, ChildVersion>>((acc, c) => {
    const seen = acc.get(c.itemId)
    if (!seen || c.quantity > seen.quantity) acc.set(c.itemId, c)
    return acc
  }, new Map())
  const byType = [...maxByItem.values()].reduce<Map<number, number>>((acc, c) => {
    acc.set(c.typeId, (acc.get(c.typeId) ?? 0) + c.quantity)
    return acc
  }, new Map())
  const lines = [...byType.entries()]
    .map(([typeId, maxQuantity]) => {
      const unit = volumeOf(typeId)
      return { typeId, maxQuantity, volume: unit == null ? null : unit * maxQuantity }
    })
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || b.maxQuantity - a.maxQuantity)
  const volumeAtLeast = lines.reduce<number | null>(
    (total, line) => (total == null || line.volume == null ? null : total + line.volume),
    0
  )
  return { lines, volumeAtLeast, distinctTypes: lines.length }
}

// ── its fuel ──────────────────────────────────────────────────────────────

// Fill is m³ of fuel aboard over the bay's capacity, read at each fuel-bay
// version and weighted by how long that version held. A version is one
// stack's quantity, so overlapping stacks of fuel at one moment are summed
// before the fill is taken. Only the moments a fuel row existed are sampled:
// an empty bay writes no row, so "lowest" is the lowest *stocked* fill, and
// the loader says so.
export const fuel = (
  children: ChildVersion[],
  capacity: number | null,
  volumeOf: (typeId: number) => number | undefined,
  lastSeen: string
): Fuel | null => {
  if (capacity == null || capacity <= 0) return null
  const rows = children.filter((c) => c.flag === FUEL_FLAG)
  if (rows.length === 0)
    return { fuelTypeId: null, capacity, meanFill: null, lowestFill: null, highestFill: null, samples: 0 }

  // The moments the stock changed: every version's open and close.
  const edges = uniq(rows.flatMap((r) => [ms(r.validFrom), ms(endOf(r, lastSeen))])).sort((a, b) => a - b)
  const fillAt = (t: number): number | null =>
    rows
      .filter((r) => ms(r.validFrom) <= t && ms(endOf(r, lastSeen)) > t)
      .reduce<number | null>((total, r) => {
        const unit = volumeOf(r.typeId)
        return total == null || unit == null ? null : total + (unit * r.quantity) / capacity
      }, 0)
  const periods = edges.slice(0, -1).map((start, i) => ({ fill: fillAt(start), duration: edges[i + 1] - start }))
  const stocked = periods.filter((p): p is { fill: number; duration: number } => p.fill != null && p.fill > 0)
  const time = stocked.reduce((total, p) => total + p.duration, 0)
  const fills = stocked.map((p) => p.fill)
  const byType = rows.reduce<Map<number, number>>((acc, r) => {
    acc.set(r.typeId, (acc.get(r.typeId) ?? 0) + r.quantity)
    return acc
  }, new Map())
  const fuelTypeId = [...byType.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    fuelTypeId,
    capacity,
    meanFill: time > 0 ? stocked.reduce((total, p) => total + p.fill * p.duration, 0) / time : null,
    lowestFill: fills.length ? Math.min(...fills) : null,
    highestFill: fills.length ? Math.max(...fills) : null,
    samples: stocked.length,
  }
}

// ── its fit and its refits ────────────────────────────────────────────────

const fitSignature = (lines: FitLine[]): string =>
  sortWith<FitLine>([ascend((l) => flagSortKey(l.flag)), ascend((l) => l.flag), ascend((l) => l.typeId)], lines)
    .map((l) => `${l.flag}:${l.typeId}:${l.quantity}`)
    .join('|')

const fitLines = (rows: ChildVersion[]): FitLine[] =>
  sortWith<FitLine>(
    [ascend((l) => flagSortKey(l.flag)), ascend((l) => l.flag), ascend((l) => l.typeId)],
    rows.map((r) => ({ flag: r.flag as string, typeId: r.typeId, quantity: r.quantity }))
  )

// The fit at every moment a slot changed, counted as distinct consecutive
// fits: swap a module and swap it back between two extracts and the extract
// saw nothing, so this too is "at least".
export const fit = (children: ChildVersion[], lastSeen: string): Fit => {
  const slotted = children.filter((c) => isSlotFlag(c.flag))
  const current = fitLines(slotted.filter((c) => c.isCurrent))
  const moments = uniq(slotted.map((c) => ms(c.validFrom))).sort((a, b) => a - b)
  const signatures = moments.map((t) =>
    fitSignature(fitLines(slotted.filter((c) => ms(c.validFrom) <= t && ms(endOf(c, lastSeen)) > t)))
  )
  const distinct = signatures.filter((s, i) => i === 0 || s !== signatures[i - 1])
  return { current, fitsSeen: distinct.length, refits: Math.max(0, distinct.length - 1) }
}

// ── where it came from ────────────────────────────────────────────────────

// The window an origin event may fall in: from one extract interval before
// the debut (the event happened after the previous run, which did not list
// the hull) up to the debut itself. A job's end is when it *could* have been
// delivered, so a job gets the same window and nothing longer: an undelivered
// job sits in the facility, and the hull debuts only when it is taken out.
const within = (at: string | null, debut: string, windowMs: number): boolean =>
  at != null && ms(at) <= ms(debut) && ms(at) >= ms(debut) - windowMs

const nearest = <T extends { at: string }>(rows: T[], debut: string): T => sortBy((r) => ms(debut) - ms(r.at), rows)[0]

// One candidate is a confident match; several of one kind in the window are
// the nearest, with less confidence (two Rifters built the same evening: it
// was one of them). The rules are tried in the plan's order, and the first
// with any candidate wins.
const confidenceOf = (candidates: number): Confidence => (candidates === 1 ? 'high' : 'medium')

// The debut is the owner's first extract (within the slack): the hull was in
// the hangar before we looked, and nothing before that run is on record.
export const predatesRecord = (recordStart: string | null, debut: string): boolean =>
  recordStart != null && ms(debut) <= ms(recordStart) + RECORD_START_SLACK_MS

export const origin = (input: DossierInput, debut: { at: string; owner: Owner; place: Place | null }): Origin => {
  const { at } = debut
  const windowMs = input.extractIntervalMs
  if (predatesRecord(input.recordStart, at)) {
    return {
      kind: 'predates_record',
      at,
      note: 'The hull was already in the hangar when the first extract ran, so its origin predates our record. Do not invent one.',
    }
  }

  const jobs = input.jobs
    .filter((j) => j.status !== 'cancelled' && j.status !== 'reverted' && within(j.endDate, at, windowMs))
    .map((j) => ({ ...j, at: j.endDate }))
  if (jobs.length > 0) {
    const pick = nearest(jobs, at)
    return {
      kind: 'built',
      at: pick.at,
      confidence: confidenceOf(jobs.length),
      jobId: pick.jobId,
      owner: pick.owner,
      runs: pick.runs,
      candidates: jobs.length,
    }
  }

  const contracts = input.contracts
    .filter(
      (c) =>
        (c.kind === 'item_exchange' || c.kind === 'auction') &&
        c.status !== 'deleted' &&
        c.status !== 'rejected' &&
        c.status !== 'cancelled' &&
        within(c.at, at, windowMs)
    )
    .map((c) => ({ ...c, at: c.at as string }))
  if (contracts.length > 0) {
    const pick = nearest(contracts, at)
    return {
      kind: 'contracted',
      at: pick.at,
      confidence: confidenceOf(contracts.length),
      contractId: pick.contractId,
      owner: pick.owner,
      contractKind: pick.kind,
      candidates: contracts.length,
    }
  }

  const buys = input.buys.filter((b) => within(b.date, at, windowMs)).map((b) => ({ ...b, at: b.date }))
  if (buys.length > 0) {
    const pick = nearest(buys, at)
    return {
      kind: 'bought',
      at: pick.at,
      confidence: confidenceOf(buys.length),
      transactionId: pick.transactionId,
      owner: pick.owner,
      unitPrice: pick.unitPrice,
      candidates: buys.length,
    }
  }

  // A packaged stack of the type at the same place, under the same owner,
  // that shrank or vanished at the debut: the hull was assembled out of it.
  // A stack version closing in the window is the shrink; a successor version
  // at the same quantity or more is a repack, not an assembly.
  const shrunk = input.stacks.filter((s) => {
    if (s.isCurrent || !sameOwner(s.owner, debut.owner) || !samePlace(s.place, debut.place)) return false
    if (!within(s.validUntil, at, windowMs)) return false
    const successor = input.stacks
      .filter((n) => n.itemId === s.itemId && ms(n.validFrom) >= ms(s.validUntil))
      .sort((a, b) => ms(a.validFrom) - ms(b.validFrom))[0]
    return successor == null || successor.quantity < s.quantity
  })
  if (shrunk.length > 0) {
    const pick = nearest(
      shrunk.map((s) => ({ ...s, at: s.validUntil })),
      at
    )
    return {
      kind: 'reassembled',
      at: pick.at,
      confidence: confidenceOf(uniq(shrunk.map((s) => s.itemId)).length),
      stackItemId: pick.itemId,
      owner: pick.owner,
      candidates: uniq(shrunk.map((s) => s.itemId)).length,
    }
  }

  return {
    kind: 'unknown',
    at,
    note: 'Nothing of this type was built, contracted, bought or unpacked just before the hull appeared. It has no known past; say so rather than invent one.',
  }
}

// ── the whole dossier ─────────────────────────────────────────────────────

export const dossier = (input: DossierInput): Dossier | null => {
  const hull = byValidFrom(input.hull)
  if (hull.length === 0) return null
  const first = hull[0]
  const newest = hull[hull.length - 1]
  const debut = { at: first.validFrom, owner: first.owner, place: first.place }
  return {
    itemId: input.itemId,
    lineage: input.lineage,
    typeId: newest.typeId,
    names: nameSpans(hull),
    debut: { ...debut, predatesRecord: predatesRecord(input.recordStart, debut.at) },
    origin: origin(input, debut),
    tenures: tenures(hull),
    itinerary: itinerary(hull, input.lastSeen),
    pilots: pilots(input.boardings, input.lastSeen),
    cargo: cargo(input.children, input.volumeOf),
    fuel: fuel(input.children, input.fuelBayCapacity, input.volumeOf, input.lastSeen),
    fit: fit(input.children, input.lastSeen),
    inHangar: newest.isCurrent,
    lastSeen: input.lastSeen,
    versions: hull.length,
  }
}
