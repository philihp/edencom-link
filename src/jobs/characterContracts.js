import { map, splitEvery } from 'ramda'

import { contractItems, contracts } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCharacter, forEachSequential } from './lib.js'
import { contractFields, contractItemFields, ITEMISED_TYPES } from './contractFields.js'

const TAG = 'character-contracts'
export const SCOPE = 'esi-contracts.read_character_contracts.v1'

// How many per-contract item lists one character may pull in a single run. The
// contracts endpoint is one paged call, but items are one call per contract, so
// a character who has just linked an account with a month of trading behind
// them would otherwise fire hundreds of requests in a single step. Items are
// immutable and fetched once, so the backlog simply drains over the next few
// 6-hourly runs — newest contracts first, which is what anyone looking at the
// data cares about.
const MAX_ITEM_FETCHES = 100

// PostgREST is happier with bounded statements than one giant array.
const UPSERT_CHUNK = 500

// Upsert the fetched contracts in place. A contract is mutable (outstanding →
// in_progress → finished, gaining an acceptor and completion date), so unlike
// the wallet-transaction extract this updates rather than ignoring duplicates.
// The conflict key is (registration_id, contract_id): a contract is visible to
// both parties, and if two of our characters are the issuer and the acceptor
// each keeps its own row.
const upsertContracts = async (registration_id, fetched, seenAt) => {
  const rows = map((c) => ({ registration_id, ...contractFields(c, seenAt) }), fetched)
  await forEachSequential(splitEvery(UPSERT_CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase
      .from('character_contract')
      .upsert(chunk, { onConflict: 'registration_id,contract_id' })
    if (error) throw error
  })
}

// Pull the item list of every contract that doesn't have one yet, up to
// MAX_ITEM_FETCHES. A contract's contents never change once it exists, so
// items_fetched_at is set afterwards and the contract is never asked about
// again — including when ESI tolerantly answers 403/404 (we're no longer a
// party to it, or it has aged out of retention), which will never become
// readable and so must not be retried forever.
const syncContractItems = async ({ access_token, characterID, registration_id, ctx }) => {
  const { data: pending, error } = await sudoSupabase
    .from('character_contract')
    .select('contract_id')
    .eq('registration_id', registration_id)
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
      const { status, json } = await contractItems(access_token, characterID, contract_id)
      const seenAt = new Date().toISOString()
      if (json?.length) {
        const rows = map((i) => ({ registration_id, contract_id, ...contractItemFields(i, seenAt) }), json)
        await forEachSequential(splitEvery(UPSERT_CHUNK, rows), async (chunk) => {
          const { error: itemsError } = await sudoSupabase
            .from('character_contract_item')
            .upsert(chunk, { onConflict: 'registration_id,contract_id,record_id' })
          if (itemsError) throw itemsError
        })
      }
      // Stamp only after the items committed, so a mid-write failure leaves the
      // contract pending rather than permanently half-itemised.
      const { error: stampError } = await sudoSupabase
        .from('character_contract')
        .update({ items_fetched_at: seenAt })
        .eq('registration_id', registration_id)
        .eq('contract_id', contract_id)
      if (stampError) throw stampError
      if (json == null) unreadable += 1
      else itemised += 1
      if (status === 403 || status === 404) {
        console.log(`[${TAG}] ${ctx}: contract ${contract_id} items unreadable (${status}), not retrying`)
      }
    } catch (e) {
      // One contract's failure (a transient 5xx, a write error) leaves it
      // pending for the next run instead of aborting this character's whole
      // backlog.
      failures += 1
      console.error(`[${TAG}] ${ctx}: contract ${contract_id} items FAILED message=${e?.message}`)
    }
  })
  return { itemised, unreadable, failures, pending: pending?.length ?? 0 }
}

// GET /characters/{id}/contracts/ → character_contract, plus
// /characters/{id}/contracts/{id}/items/ → character_contract_item for
// contracts we haven't itemised yet. ESI returns contracts from the last 30
// days plus everything still outstanding or in progress, so the upsert both
// discovers new contracts and advances the status of ones we already hold.
// Deliberately unconditional: the contracts endpoint is page-numbered, and an
// ETag would only ever cover one page.
export const runCharacterContracts = ({ registrationIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, characterID, registration_id, name, ctx }) => {
      const fetched = await fetchAllPages((page) => contracts(access_token, characterID, page))
      await upsertContracts(registration_id, fetched, new Date().toISOString())
      const { itemised, unreadable, failures, pending } = await syncContractItems({
        access_token,
        characterID,
        registration_id,
        ctx,
      })
      console.log(
        `[${TAG}] ${name} ${registration_id} (${characterID}): ${fetched.length} contracts; ` +
          `${pending} awaiting items, ${itemised} itemised, ${unreadable} unreadable, ${failures} failed`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterContracts)
