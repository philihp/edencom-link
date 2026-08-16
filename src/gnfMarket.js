// The single module in the repo that talks to the GNF appraisal service
// (https://appraise.gnf.lt) — a public, unauthenticated price feed covering
// the alliance's market hubs plus the empire hubs. Unlike src/kumgo.ts and
// src/innominate.ts, which are called at request time, this one is only ever
// reached by the hourly market-prices extract job: the feed is bulk static
// data about the game world (no player data, identical for every caller), so
// it follows the normal "ESI → DB → server components read DB" flow with
// appraise.gnf.lt standing in for ESI.
//
// The market ids are the values the service's own appraisal form offers.
// C-J6MT and jita are the two the industry spreadsheet prices against; the
// rest are listed so adding one is a constant change rather than a guess.
export const KNOWN_MARKETS = [
  'C-J6MT',
  'UALX-3',
  'HY-RWO',
  'O4T-Z5',
  'R-ARKN',
  'GB-6X5',
  'GM-0K7',
  'jita',
  'amarr',
  'dodixie',
  'universe',
]

// The markets the hourly job actually captures. Everything downstream — the
// job, the workflow's per-market fan-out, and the /sheets/market/<market>
// route's allowlist — reads this one list.
export const TRACKED_MARKETS = ['C-J6MT', 'jita']

const BASE = 'https://appraise.gnf.lt'

// A truncated response would look to the reconcile like "every missing type
// stopped being sold", closing thousands of rows on what is really a network
// hiccup. Every market the service publishes carries north of 20k types, so a
// response this far below that is refused rather than reconciled.
export const MIN_PLAUSIBLE_TYPES = 10000

// GET /market/<market>/prices.json → the raw feed, one entry per type id:
//   { typeID, prices: { all, buy, sell, updated, strategy } }
// where buy/sell each carry { avg, max, median, min, percentile, stddev,
// volume, order_count }. Roughly 11 MB per market, refreshed hourly upstream.
export const fetchMarketPrices = async (market) => {
  const response = await fetch(`${BASE}/market/${encodeURIComponent(market)}/prices.json`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`appraise.gnf.lt ${market}: HTTP ${response.status}`)
  }
  const json = await response.json()
  if (!Array.isArray(json)) {
    throw new Error(`appraise.gnf.lt ${market}: expected an array, got ${typeof json}`)
  }
  if (json.length < MIN_PLAUSIBLE_TYPES) {
    throw new Error(
      `appraise.gnf.lt ${market}: only ${json.length} type(s), below the ${MIN_PLAUSIBLE_TYPES} floor — refusing to reconcile a truncated feed`
    )
  }
  return json
}
