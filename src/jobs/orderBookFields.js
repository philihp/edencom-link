// Pure seam for the market-depth job (src/jobs/marketDepth.js): ESI region
// orders → market_order_book rows. No I/O, so test/orderBookFields.test.ts
// covers it without a database.
import { filter, map, pipe, propEq } from 'ramda'

// The Forge, and the Jita IV - Moon 4 - Caldari Navy Assembly Plant: the
// station the 'jita' market preset means.
export const THE_FORGE = 10000002
export const JITA_44 = 60003760
export const JITA_MARKET = 'jita'

// The sell orders at one station, as rows stamped with the run's clock. A buy
// order, or a sell order in another station of the region, is not part of the
// book a buyer at that station walks up.
export const toBookRows = (market, locationId, capturedAt) =>
  pipe(
    filter((o) => o.is_buy_order !== true),
    filter(propEq(locationId, 'location_id')),
    map((o) => ({
      market,
      order_id: o.order_id,
      type_id: o.type_id,
      location_id: o.location_id,
      price: o.price,
      volume_remain: o.volume_remain,
      issued: o.issued ?? null,
      captured_at: capturedAt,
    }))
  )
