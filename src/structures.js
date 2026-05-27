import { character as fetchCharacter, corpStructures, corpWalletJournal, userAgent } from './esi.js'
import SingleSignOn from './sso.js'
import { sudoSupabase } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const STRUCTURES_SCOPE = 'esi-corporations.read_structures.v1'
const WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1'
const JOURNAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const WALLET_DIVISIONS = [1, 2, 3, 4, 5, 6, 7]

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, { userAgent })

const tail = (s) => (typeof s === 'string' && s.length > 4 ? s.slice(-4) : '????')

const refreshToken = async (tokenRow) => {
  const refreshed = await sso.refreshAccessToken(tokenRow.refresh_token)
  const { access_token, refresh_token } = refreshed
  const { sub, scp = [], iat, exp } = refreshed.decoded_access_token
  const characterID = sub.split(':')[2]
  const scope = [scp].flat()
  const issued_at = new Date(iat * 1000).toISOString()
  const expires_at = new Date(exp * 1000).toISOString()
  await sudoSupabase
    .schema('hangar')
    .from('token')
    .update({ access_token, refresh_token, issued_at, expires_at, scope })
    .eq('id', tokenRow.id)
  return { access_token, characterID, scope, issued_at, expires_at }
}

const execute = async () => {
  const { data: tokens, error } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [STRUCTURES_SCOPE])

  if (error) {
    console.error('[structures] token lookup failed:', error)
    process.exit(1)
  }

  console.log(`[structures] found ${tokens?.length ?? 0} token(s) with ${STRUCTURES_SCOPE}`)
  for (const t of tokens ?? []) {
    console.log(`[structures]   token ${t.id} character ${t.character_id} refresh ...${tail(t.refresh_token)}`)
  }

  const seenCorps = new Set()
  for (const tokenRow of tokens ?? []) {
    const t0 = Date.now()
    const ctx = `character=${tokenRow.character_id} token=${tokenRow.id}`
    try {
      console.log(`[structures] ${ctx}: refreshing token (refresh ...${tail(tokenRow.refresh_token)})`)
      const { access_token, characterID, scope, issued_at, expires_at } = await refreshToken(tokenRow)
      console.log(
        `[structures] ${ctx}: refreshed characterID=${characterID} issued=${issued_at} expires=${expires_at} scope=${JSON.stringify(scope)}`
      )
      if (!scope.includes(STRUCTURES_SCOPE)) {
        console.error(
          `[structures] ${ctx}: refreshed token NO LONGER has ${STRUCTURES_SCOPE} (scope=${JSON.stringify(scope)}) — skipping`
        )
        continue
      }

      console.log(`[structures] ${ctx}: fetching character info`)
      const info = await fetchCharacter(access_token, characterID)
      const corporation_id = info?.corporation_id
      const alliance_id = info?.alliance_id ?? null
      console.log(`[structures] ${ctx}: character corporation_id=${corporation_id} alliance_id=${alliance_id}`)
      if (!corporation_id) {
        console.error(`[structures] ${ctx}: character payload missing corporation_id, raw=${JSON.stringify(info)}`)
        continue
      }

      const { error: charUpdateErr, status: charUpdateStatus } = await sudoSupabase
        .schema('hangar')
        .from('character')
        .update({ corporation_id })
        .eq('id', tokenRow.character_id)
      if (charUpdateErr) {
        console.error(
          `[structures] ${ctx}: character.corporation_id update failed status=${charUpdateStatus} code=${charUpdateErr.code} message=${charUpdateErr.message} details=${charUpdateErr.details} hint=${charUpdateErr.hint}`
        )
      } else {
        console.log(`[structures] ${ctx}: character.corporation_id updated (status=${charUpdateStatus})`)
      }

      if (seenCorps.has(corporation_id)) {
        console.log(`[structures] ${ctx}: corp ${corporation_id} already pulled this run, skipping structures fetch`)
        continue
      }
      seenCorps.add(corporation_id)

      const all = []
      console.log(`[structures] ${ctx}: fetching corp ${corporation_id} structures page 1`)
      const [firstPage, pagesHeader] = await corpStructures(access_token, corporation_id, 1)
      console.log(
        `[structures] ${ctx}: corp ${corporation_id} page 1 returned ${firstPage?.length ?? 0} rows, x-pages=${pagesHeader}`
      )
      all.push(...firstPage)
      const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
      for (let page = 2; page <= totalPages; page++) {
        console.log(`[structures] ${ctx}: fetching corp ${corporation_id} structures page ${page}/${totalPages}`)
        const [more] = await corpStructures(access_token, corporation_id, page)
        console.log(`[structures] ${ctx}: corp ${corporation_id} page ${page} returned ${more?.length ?? 0} rows`)
        all.push(...more)
      }

      const now = new Date().toISOString()
      const rows = all.map((s) => ({
        structure_id: s.structure_id,
        corporation_id: s.corporation_id,
        type_id: s.type_id,
        system_id: s.system_id,
        profile_id: s.profile_id ?? null,
        name: s.name ?? null,
        state: s.state ?? null,
        fuel_expires: s.fuel_expires ?? null,
        unanchors_at: s.unanchors_at ?? null,
        reinforce_hour: s.reinforce_hour ?? null,
        next_reinforce_hour: s.next_reinforce_hour ?? null,
        next_reinforce_apply: s.next_reinforce_apply ?? null,
        next_reinforce_weekday: s.next_reinforce_weekday ?? null,
        services: s.services ?? null,
        last_seen_at: now,
        updated_at: now,
      }))

      if (rows.length > 0) {
        console.log(
          `[structures] ${ctx}: upserting ${rows.length} structure row(s) for corp ${corporation_id} sample=${JSON.stringify(rows[0])}`
        )
        const { error: upsertErr, status: upsertStatus } = await sudoSupabase
          .schema('hangar')
          .from('corp_structure')
          .upsert(rows, { onConflict: 'structure_id' })
        if (upsertErr) {
          console.error(
            `[structures] ${ctx}: upsert failed status=${upsertStatus} code=${upsertErr.code} message=${upsertErr.message} details=${upsertErr.details} hint=${upsertErr.hint}`
          )
          throw upsertErr
        }
        console.log(`[structures] ${ctx}: upsert ok (status=${upsertStatus})`)
      } else {
        console.log(`[structures] ${ctx}: corp ${corporation_id} returned zero structures, nothing to upsert`)
      }

      const dt = Date.now() - t0
      console.log(`[structures] ${ctx}: done corp ${corporation_id} ${rows.length} fetched in ${dt}ms`)

      if (scope.includes(WALLET_SCOPE)) {
        const cutoff = Date.now() - JOURNAL_LOOKBACK_MS
        for (const division of WALLET_DIVISIONS) {
          const journalRows = []
          try {
            for (let page = 1; ; page++) {
              const [entries, pagesHeader] = await corpWalletJournal(access_token, corporation_id, division, page)
              if (!Array.isArray(entries) || entries.length === 0) break
              let oldestMs = Infinity
              for (const e of entries) {
                const ms = new Date(e.date).getTime()
                if (ms < oldestMs) oldestMs = ms
                if (ms < cutoff) continue
                journalRows.push({
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
            if (journalRows.length > 0) {
              const { error: jErr } = await sudoSupabase
                .schema('hangar')
                .from('corp_wallet_journal')
                .upsert(journalRows, { onConflict: 'corporation_id,division,entry_id', ignoreDuplicates: true })
              if (jErr) throw jErr
            }
            console.log(`[corp-wallet] ${ctx}: corp ${corporation_id} div ${division} ${journalRows.length} entries`)
          } catch (jErr) {
            console.error(
              `[corp-wallet] ${ctx}: corp ${corporation_id} div ${division} FAILED message=${jErr?.message}`
            )
          }
        }
      }
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[structures] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }
}

execute()
