import { filter, map, pipe, reduce } from 'ramda'

import { corpWalletJournal } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCorporation, forEachSequential } from './lib.js'

const TAG = 'corp-wallet-journal'
const SCOPE = 'esi-wallet.read_corporation_wallets.v1'

const JOURNAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const WALLET_DIVISIONS = [1, 2, 3, 4, 5, 6, 7]

const toRow = (corporation_id, division) => (e) => ({
  corporation_id,
  division,
  entry_id: e.id,
  date: e.date,
  ref_type: e.ref_type,
  amount: e.amount ?? null,
  balance: e.balance ?? null,
  reason: e.reason ?? null,
  description: e.description ?? null,
  first_party_id: e.first_party_id ?? null,
  second_party_id: e.second_party_id ?? null,
  context_id: e.context_id ?? null,
  context_id_type: e.context_id_type ?? null,
  tax: e.tax ?? null,
  tax_receiver_id: e.tax_receiver_id ?? null,
})

// One page of one division's journal: rows past the cutoff plus, when the
// page still has entries as old as the cutoff or ESI says there's more, the
// rest of the pages recursively. `oldestMs` covers every entry on the page
// (not just the ones kept), so a page straddling the cutoff still stops the
// walk instead of paging on forever.
const fetchDivisionPage = async (access_token, corporation_id, division, cutoff, page) => {
  const [entries, pagesHeader] = await corpWalletJournal(access_token, corporation_id, division, page)
  if (!Array.isArray(entries) || entries.length === 0) return []

  const oldestMs = reduce((min, e) => Math.min(min, new Date(e.date).getTime()), Infinity, entries)
  const rows = pipe(
    filter((e) => new Date(e.date).getTime() >= cutoff),
    map(toRow(corporation_id, division))
  )(entries)

  const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
  if (oldestMs < cutoff || page >= totalPages) return rows
  return [...rows, ...(await fetchDivisionPage(access_token, corporation_id, division, cutoff, page + 1))]
}

// GET /corporations/{id}/wallets/{division}/journal/ → corp_wallet_journal.
// Pulls every wallet division back to a 30-day cutoff; entry ids are stable so
// the upsert dedupes re-fetches. Each division is isolated: one division
// failing (e.g. a permissions edge) doesn't abort the others.
const fetchDivision = (access_token, corporation_id, division, cutoff) =>
  fetchDivisionPage(access_token, corporation_id, division, cutoff, 1)

export const runCorpWalletJournal = ({ characterIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, characterIds }, async ({ access_token, corporation_id, ctx }) => {
    const cutoff = Date.now() - JOURNAL_LOOKBACK_MS
    await forEachSequential(WALLET_DIVISIONS, async (division) => {
      try {
        const rows = await fetchDivision(access_token, corporation_id, division, cutoff)
        if (rows.length > 0) {
          const { error } = await sudoSupabase
            .from('corp_wallet_journal')
            .upsert(rows, { onConflict: 'corporation_id,division,entry_id', ignoreDuplicates: true })
          if (error) throw error
        }
        console.log(`[${TAG}] ${ctx}: corp ${corporation_id} div ${division} ${rows.length} entries`)
      } catch (e) {
        console.error(`[${TAG}] ${ctx}: corp ${corporation_id} div ${division} FAILED message=${e?.message}`)
      }
    })
  })

cli(import.meta.url, TAG, runCorpWalletJournal)
