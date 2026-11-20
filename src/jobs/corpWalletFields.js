import { filter, map, pipe } from 'ramda'

// ESI /corporations/{id}/wallets/ → corp_wallet rows. The pure seam of the
// balance pull in corp-wallet-journal (ledger stage 1, docs/ledger/stage-1.md).
// A division outside 1..7 or a balance that is not a number is dropped, never
// stored: corp_wallet is a control, and a wrong control is worse than none.
const isDivision = (d) => Number.isInteger(d) && d >= 1 && d <= 7

export const toWalletRows = (corporation_id, wallets) =>
  pipe(
    filter((w) => isDivision(w?.division) && Number.isFinite(w?.balance)),
    map((w) => ({ corporation_id, division: w.division, balance: w.balance }))
  )(Array.isArray(wallets) ? wallets : [])
