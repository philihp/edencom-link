import { corpWalletJournal } from './esi.js'
import { sudoSupabase } from './supabase.js'

const JOURNAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const WALLET_DIVISIONS = [1, 2, 3, 4, 5, 6, 7]

const fetchDivision = async (access_token, corporation_id, division, cutoff) => {
  const rows = []
  for (let page = 1; ; page++) {
    const [entries, pagesHeader] = await corpWalletJournal(access_token, corporation_id, division, page)
    if (!Array.isArray(entries) || entries.length === 0) break
    let oldestMs = Infinity
    for (const e of entries) {
      const ms = new Date(e.date).getTime()
      if (ms < oldestMs) oldestMs = ms
      if (ms < cutoff) continue
      rows.push({
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
    }
    const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
    if (oldestMs < cutoff || page >= totalPages) break
  }
  return rows
}

export const pullCorpWalletJournals = async ({ access_token, corporation_id, ctx, corpLabel = corporation_id }) => {
  const cutoff = Date.now() - JOURNAL_LOOKBACK_MS
  for (const division of WALLET_DIVISIONS) {
    try {
      const rows = await fetchDivision(access_token, corporation_id, division, cutoff)
      if (rows.length > 0) {
        const { error } = await sudoSupabase
          .from('corp_wallet_journal')
          .upsert(rows, { onConflict: 'corporation_id,division,entry_id', ignoreDuplicates: true })
        if (error) throw error
      }
      console.log(`[corp-wallet] ${ctx}: corp ${corpLabel} div ${division} ${rows.length} entries`)
    } catch (e) {
      console.error(`[corp-wallet] ${ctx}: corp ${corpLabel} div ${division} FAILED message=${e?.message}`)
    }
  }
}
