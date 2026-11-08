// The market tab's pure fold: for each stock type, what the account holds,
// what is being built, and what is listed for sale in each of the two market
// regions, against the two market targets. No I/O, so
// test/plannerMarketRows.test.ts runs it under the node test runner.
//
// The columns follow the sheet's Market tab: home target, Jita target,
// inventory, in flight, home listed, Jita listed, the two market shares, the
// import price. "Listed" is what is on sell orders OR offered on outstanding
// item-exchange and auction contracts in that region, since both are stock
// that is for sale there and neither is in a hangar.
import { groupBy, reduce, sum } from 'ramda'

import type { StockTarget } from '../stock-types/stockTargets'

// A hangar stack of one type, asset-safety stock already taken out.
export type Stack = { typeId: number; quantity: number }
// A sell order, or one contract line, of one type in one region.
export type Listing = { typeId: number; regionId: number | null; quantity: number }
// An open manufacturing or reaction job: how many units of the product it
// will deliver (runs × the blueprint's units per run).
export type OpenJob = { typeId: number; units: number }

export type MarketRegions = { homeRegionId: number; jitaRegionId: number }

export type MarketLine = {
  typeId: number
  homeTarget: number
  jitaTarget: number
  inventory: number
  inFlight: number
  homeListed: number
  jitaListed: number
  // listed ÷ target, or null where the target is zero.
  homeShare: number | null
  jitaShare: number | null
  // Jita's best ask for the type, or null when the capture has none.
  importPrice: number | null
}

const sumBy =
  <T>(quantity: (t: T) => number) =>
  (items: readonly T[] | undefined): number =>
    sum((items ?? []).map(quantity))

const share = (listed: number, target: number): number | null => (target > 0 ? listed / target : null)

export const marketLines = (
  targets: readonly StockTarget[],
  stacks: readonly Stack[],
  listings: readonly Listing[],
  jobs: readonly OpenJob[],
  jitaAsk: ReadonlyMap<number, number>,
  { homeRegionId, jitaRegionId }: MarketRegions
): MarketLine[] => {
  const byType = <T extends { typeId: number }>(items: readonly T[]) => groupBy((i: T) => String(i.typeId), items)
  const stacksOf = byType(stacks)
  const jobsOf = byType(jobs)
  const listedOf = byType(listings)
  const inRegion = (regionId: number) => (l: Listing) => l.regionId === regionId
  const quantity = sumBy((s: { quantity: number }) => s.quantity)
  const units = sumBy((j: OpenJob) => j.units)

  return reduce(
    (acc: MarketLine[], t: StockTarget) => {
      const key = String(t.typeId)
      const listed = listedOf[key] ?? []
      const homeListed = quantity(listed.filter(inRegion(homeRegionId)))
      const jitaListed = quantity(listed.filter(inRegion(jitaRegionId)))
      acc.push({
        typeId: t.typeId,
        homeTarget: t.home,
        jitaTarget: t.jita,
        inventory: quantity(stacksOf[key]),
        inFlight: units(jobsOf[key]),
        homeListed,
        jitaListed,
        homeShare: share(homeListed, t.home),
        jitaShare: share(jitaListed, t.jita),
        importPrice: jitaAsk.get(t.typeId) ?? null,
      })
      return acc
    },
    [],
    targets
  )
}

// A location id's kind, from its range: NPC stations sit in 60,000,000–
// 69,999,999, player structures above 1,000,000,000. Contracts carry only
// the id, so this is how the region lookup knows which table names it.
export const locationKind = (locationId: number): 'station' | 'structure' | 'other' =>
  locationId >= 60_000_000 && locationId < 70_000_000 ? 'station' : locationId >= 1_000_000_000 ? 'structure' : 'other'
