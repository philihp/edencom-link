import { industryJobs, transactions, wallet } from './esi.js'
import { sudoSupabase } from './supabase.js'
import { refreshAccessToken } from './tokenRefresh.js'

const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1'
const INDUSTRY_SCOPE = 'esi-industry.read_character_jobs.v1'

const execute = async () => {
  const { data: characters, error: charactersError } = await sudoSupabase
    .schema('hangar')
    .from('registration')
    .select('id, name')
  if (charactersError) {
    console.error(charactersError)
    process.exit(1)
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))

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
    const name = characterName.get(tokenRow.character_id) ?? '?'
    try {
      const { access_token, characterID } = await refreshAccessToken(tokenRow)
      const balance = await wallet(access_token, characterID)
      const { error: insertError } = await sudoSupabase
        .schema('hangar')
        .from('wallet')
        .insert({ character_id: tokenRow.character_id, balance })
      if (insertError) throw insertError
      console.log(`wallet ${name} ${tokenRow.character_id} (${characterID}): ${balance}`)

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
        console.log(`transactions ${name} ${tokenRow.character_id} (${characterID}): ${txns.length} fetched`)
      }
    } catch (e) {
      console.error(`refresh failed for ${name} ${tokenRow.character_id}:`, e)
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
    const name = characterName.get(tokenRow.character_id) ?? '?'
    try {
      const { access_token, characterID } = await refreshAccessToken(tokenRow)
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
      console.log(`industry ${name} ${tokenRow.character_id} (${characterID}): ${jobs.length} jobs`)
    } catch (e) {
      console.error(`industry refresh failed for ${name} ${tokenRow.character_id}:`, e)
    }
  }
}

execute()
