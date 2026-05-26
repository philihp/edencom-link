import { character as fetchCharacter, corpStructures, industryJobs, transactions, userAgent, wallet } from './esi.js'
import SingleSignOn from './sso.js'
import { sudoSupabase } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1'
const INDUSTRY_SCOPE = 'esi-industry.read_character_jobs.v1'
const STRUCTURES_SCOPE = 'esi-corporations.read_structures.v1'

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, { userAgent })

const refreshToken = async (tokenRow) => {
  const refreshed = await sso.getAccessToken(tokenRow.refresh_token, true)
  const { access_token, refresh_token } = refreshed
  const { sub, scp = [], iat, exp } = refreshed.decoded_access_token
  const characterID = sub.split(':')[2]
  const scope = [scp].flat()
  await sudoSupabase
    .schema('hangar')
    .from('token')
    .update({
      access_token,
      refresh_token,
      issued_at: new Date(iat * 1000).toISOString(),
      expires_at: new Date(exp * 1000).toISOString(),
      scope,
    })
    .eq('id', tokenRow.id)
  return { access_token, characterID, scope }
}

const execute = async () => {
  const { data: tokens, error } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [WALLET_SCOPE])

  if (error) {
    console.error(error)
    process.exit(1)
  }

  for (const tokenRow of tokens ?? []) {
    try {
      const { access_token, characterID } = await refreshToken(tokenRow)
      const balance = await wallet(access_token, characterID)
      const { error: insertError } = await sudoSupabase
        .schema('hangar')
        .from('wallet')
        .insert({ character_id: tokenRow.character_id, balance })
      if (insertError) throw insertError
      console.log(`wallet ${tokenRow.character_id} (${characterID}): ${balance}`)

      const txns = await transactions(access_token, characterID)
      if (txns.length > 0) {
        const rows = txns.map((t) => ({
          transaction_id: t.transaction_id,
          character_id: tokenRow.character_id,
          date: t.date,
          type_id: t.type_id,
          quantity: t.quantity,
          unit_price: t.unit_price,
          is_buy: t.is_buy,
          is_personal: t.is_personal,
          client_id: t.client_id,
          location_id: t.location_id,
          journal_ref_id: t.journal_ref_id,
        }))
        const { error: txError } = await sudoSupabase
          .schema('hangar')
          .from('market_transaction')
          .upsert(rows, { onConflict: 'transaction_id', ignoreDuplicates: true })
        if (txError) throw txError
        console.log(`transactions ${tokenRow.character_id} (${characterID}): ${txns.length} fetched`)
      }
    } catch (e) {
      console.error(`refresh failed for ${tokenRow.character_id}:`, e)
    }
  }

  const { data: industryTokens, error: industryTokensError } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [INDUSTRY_SCOPE])

  if (industryTokensError) {
    console.error(industryTokensError)
    process.exit(1)
  }

  for (const tokenRow of industryTokens ?? []) {
    try {
      const { access_token, characterID } = await refreshToken(tokenRow)
      const jobs = await industryJobs(access_token, characterID)
      if (jobs.length > 0) {
        const rows = jobs.map((j) => ({
          job_id: j.job_id,
          character_id: tokenRow.character_id,
          installer_id: j.installer_id,
          facility_id: j.facility_id,
          station_id: j.station_id ?? null,
          activity_id: j.activity_id,
          blueprint_id: j.blueprint_id,
          blueprint_type_id: j.blueprint_type_id,
          blueprint_location_id: j.blueprint_location_id,
          output_location_id: j.output_location_id,
          product_type_id: j.product_type_id ?? null,
          runs: j.runs,
          cost: j.cost ?? null,
          licensed_runs: j.licensed_runs ?? null,
          probability: j.probability ?? null,
          status: j.status,
          duration: j.duration,
          start_date: j.start_date,
          end_date: j.end_date,
          pause_date: j.pause_date ?? null,
          completed_date: j.completed_date ?? null,
          completed_character_id: j.completed_character_id ?? null,
          successful_runs: j.successful_runs ?? null,
        }))
        const { error: jobError } = await sudoSupabase
          .schema('hangar')
          .from('industry_job')
          .upsert(rows, { onConflict: 'job_id' })
        if (jobError) throw jobError
      }
      console.log(`industry ${tokenRow.character_id} (${characterID}): ${jobs.length} jobs`)
    } catch (e) {
      console.error(`industry refresh failed for ${tokenRow.character_id}:`, e)
    }
  }

  const { data: structureTokens, error: structureErr } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [STRUCTURES_SCOPE])

  if (structureErr) {
    console.error(structureErr)
    return
  }

  const seenCorps = new Set()
  for (const tokenRow of structureTokens ?? []) {
    try {
      const { access_token, characterID } = await refreshToken(tokenRow)
      const info = await fetchCharacter(access_token, characterID)
      const corporation_id = info.corporation_id

      await sudoSupabase
        .schema('hangar')
        .from('character')
        .update({ corporation_id })
        .eq('id', tokenRow.character_id)

      if (seenCorps.has(corporation_id)) continue
      seenCorps.add(corporation_id)

      const all = []
      const [firstPage, pagesHeader] = await corpStructures(access_token, corporation_id, 1)
      all.push(...firstPage)
      const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
      for (let page = 2; page <= totalPages; page++) {
        const [more] = await corpStructures(access_token, corporation_id, page)
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
        const { error: upsertErr } = await sudoSupabase
          .schema('hangar')
          .from('corp_structure')
          .upsert(rows, { onConflict: 'structure_id' })
        if (upsertErr) throw upsertErr
      }
      console.log(`structures corp ${corporation_id} via ${characterID}: ${rows.length} fetched`)
    } catch (e) {
      console.error(`structures failed for ${tokenRow.character_id}:`, e)
    }
  }
}

execute()
