import { map, splitEvery } from 'ramda'

import { corpContractItems, corpContracts } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation, forEachSequential } from './lib.js'
import { contractFields, contractItemFields, ITEMISED_TYPES } from './contractFields.js'

const TAG = 'corp-contracts'
export const SCOPE = 'esi-contracts.read_corporation_contracts.v1'

// Same per-run item budget and chunking as the per-character twin
// (src/jobs/characterContracts.js) — see the comments there.
const MAX_ITEM_FETCHES = 100
const UPSERT_CHUNK = 500

// Upsert a corp's contracts in place, keyed on (corporation_id, contract_id).
// `registration_id` records which token scanned the row; whichever character
// forEachCorporation picked this run wins, which is the same last-scanner-wins
// attribution corp_wallet_transaction uses.
const upsertContracts = async (corporation_id, registration_id, fetched, seenAt) => {
  const rows = map((c) => ({ corporation_id, registration_id, ...contractFields(c, seenAt) }), fetched)
  await forEachSequential(splitEvery(UPSERT_CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase
      .from('corp_contract')
      .upsert(chunk, { onConflict: 'corporation_id,contract_id' })
    if (error) throw error
  })
}

// Pull the item list of every corp contract that doesn't have one yet, up to
// MAX_ITEM_FETCHES, stamping items_fetched_at so a contract is only ever asked
// about once — including on a tolerated 403/404, which will never become
// readable.
const syncContractItems = async ({ access_token, corporation_id, ctx }) => {
  const { data: pending, error } = await sudoSupabase
    .from('corp_contract')
    .select('contract_id')
    .eq('corporation_id', corporation_id)
    .is('items_fetched_at', null)
    .in('type', ITEMISED_TYPES)
    .order('date_issued', { ascending: false })
    .limit(MAX_ITEM_FETCHES)
  if (error) throw error

  let itemised = 0
  let unreadable = 0
  let failures = 0
  await forEachSequential(pending ?? [], async ({ contract_id }) => {
    try {
      const { status, json } = await corpContractItems(access_token, corporation_id, contract_id)
      const seenAt = new Date().toISOString()
      if (json?.length) {
        const rows = map((i) => ({ corporation_id, contract_id, ...contractItemFields(i, seenAt) }), json)
        await forEachSequential(splitEvery(UPSERT_CHUNK, rows), async (chunk) => {
          const { error: itemsError } = await sudoSupabase
            .from('corp_contract_item')
            .upsert(chunk, { onConflict: 'corporation_id,contract_id,record_id' })
          if (itemsError) throw itemsError
        })
      }
      // Stamp only after the items committed (see characterContracts.js).
      const { error: stampError } = await sudoSupabase
        .from('corp_contract')
        .update({ items_fetched_at: seenAt })
        .eq('corporation_id', corporation_id)
        .eq('contract_id', contract_id)
      if (stampError) throw stampError
      if (json == null) unreadable += 1
      else itemised += 1
      if (status === 403 || status === 404) {
        console.log(`[${TAG}] ${ctx}: contract ${contract_id} items unreadable (${status}), not retrying`)
      }
    } catch (e) {
      failures += 1
      console.error(`[${TAG}] ${ctx}: contract ${contract_id} items FAILED message=${e?.message}`)
    }
  })
  return { itemised, unreadable, failures, pending: pending?.length ?? 0 }
}

// GET /corporations/{id}/contracts/ → corp_contract, plus
// /corporations/{id}/contracts/{id}/items/ → corp_contract_item for contracts
// not yet itemised. One call per corporation, not per character: a corp's
// contract set is the same whichever member's token reads it, so
// forEachCorporation dedupes the caller's alts down to one pull (and falls back
// through them if one lacks the in-game role ESI separately requires).
export const runCorpContracts = ({ registrationIds } = {}) =>
  forEachCorporation(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, corporation_id, registration_id, ctx }) => {
      const fetched = await fetchAllPages((page) => corpContracts(access_token, corporation_id, page))
      await upsertContracts(corporation_id, registration_id, fetched, new Date().toISOString())
      const { itemised, unreadable, failures, pending } = await syncContractItems({
        access_token,
        corporation_id,
        ctx,
      })
      console.log(
        `[${TAG}] ${ctx}: corp ${corporation_id} ${fetched.length} contracts; ` +
          `${pending} awaiting items, ${itemised} itemised, ${unreadable} unreadable, ${failures} failed`
      )
    }
  )

cli(import.meta.url, TAG, runCorpContracts)
