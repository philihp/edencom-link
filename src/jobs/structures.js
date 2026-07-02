import { fileURLToPath } from 'node:url'

import { pullCorpWalletJournals } from '../corpWalletJournal.js'
import { character as fetchCharacter, corpAssets, corpIndustryJobs, corpStructures, universeNames } from '../esi.js'
import { resolveAssetStationNames, resolveCorpJournalNames, resolveCorpStructureSystemNames } from '../resolveNames.js'
import { resolveStructureNames } from '../structureNames.js'
import { sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'

const STRUCTURES_SCOPE = 'esi-corporations.read_structures.v1'
const WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1'
const ASSETS_SCOPE = 'esi-assets.read_corporation_assets.v1'
const JOBS_SCOPE = 'esi-industry.read_corporation_jobs.v1'

// Items fitted to an Upwell structure show up in corp assets with location_id
// equal to the structure_id and a RigSlotN location_flag.
const isRigSlot = (flag) => typeof flag === 'string' && flag.startsWith('RigSlot')

const tail = (s) => (typeof s === 'string' && s.length > 4 ? s.slice(-4) : '????')

// Corp names are public; resolve once per run and reuse so log lines read as
// "Corp Name (98000001)" instead of a bare id.
const corpNameCache = new Map()
const resolveCorpName = async (corporation_id) => {
  if (corpNameCache.has(corporation_id)) return corpNameCache.get(corporation_id)
  let name = null
  try {
    const [n] = await universeNames([corporation_id])
    name = n?.name ?? null
  } catch (e) {
    console.warn(`[structures] universe/names corp ${corporation_id} failed: ${e?.message}`)
  }
  corpNameCache.set(corporation_id, name)
  return name
}
const corpLabelFor = (name, corporation_id) => (name ? `${name} (${corporation_id})` : `${corporation_id}`)

// Pull corp structures (plus structure rigs and corp wallet journals where the
// linked tokens allow) for tokens carrying the structures scope. Pass `characterIds`
// to scope the run to specific registrations (e.g. a single character fanned out from
// the Vercel queue); omit it to refresh everyone, as the scheduled workflow does. Two
// characters in the same corp each re-process that corp — harmless, just redundant.
// Throws on a fatal lookup failure so callers — the CLI wrapper or the queue consumer
// — can decide how to surface it.
export const runStructures = async ({ characterIds } = {}) => {
  const { data: characters, error: charactersError } = await sudoSupabase.from('registration').select('id, name')
  if (charactersError) {
    console.error('[structures] character lookup failed:', charactersError)
    throw charactersError
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))

  let tokenQuery = sudoSupabase
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [STRUCTURES_SCOPE])
  if (characterIds) tokenQuery = tokenQuery.in('character_id', characterIds)
  const { data: tokens, error } = await tokenQuery

  if (error) {
    console.error('[structures] token lookup failed:', error)
    throw error
  }

  console.log(`[structures] found ${tokens?.length ?? 0} token(s) with ${STRUCTURES_SCOPE}`)
  for (const t of tokens ?? []) {
    const name = characterName.get(t.character_id) ?? '?'
    console.log(
      `[structures]   token ${t.id} character ${name} (${t.character_id}) refresh ...${tail(t.refresh_token)}`
    )
  }

  const seenStructureCorps = new Set()
  const seenWalletCorps = new Set()
  const seenAssetCorps = new Set()
  const seenJobsCorps = new Set()
  for (const tokenRow of tokens ?? []) {
    const t0 = Date.now()
    const name = characterName.get(tokenRow.character_id) ?? '?'
    const ctx = `character=${name} (${tokenRow.character_id}) token=${tokenRow.id}`
    try {
      console.log(`[structures] ${ctx}: refreshing token (refresh ...${tail(tokenRow.refresh_token)})`)
      const { access_token, characterID, scope, issued_at, expires_at } = await refreshAccessToken(tokenRow)
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
      if (!corporation_id) {
        console.error(`[structures] ${ctx}: character payload missing corporation_id, raw=${JSON.stringify(info)}`)
        continue
      }
      const corpLabel = corpLabelFor(await resolveCorpName(corporation_id), corporation_id)
      console.log(`[structures] ${ctx}: character corporation=${corpLabel} alliance_id=${alliance_id}`)

      const { error: charUpdateErr, status: charUpdateStatus } = await sudoSupabase
        .from('registration')
        .update({ corporation_id })
        .eq('id', tokenRow.character_id)
      if (charUpdateErr) {
        console.error(
          `[structures] ${ctx}: character.corporation_id update failed status=${charUpdateStatus} code=${charUpdateErr.code} message=${charUpdateErr.message} details=${charUpdateErr.details} hint=${charUpdateErr.hint}`
        )
      } else {
        console.log(`[structures] ${ctx}: character.corporation_id updated (status=${charUpdateStatus})`)
      }

      if (seenStructureCorps.has(corporation_id)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} structures already pulled this run, skipping`)
      } else {
        seenStructureCorps.add(corporation_id)

        const all = []
        console.log(`[structures] ${ctx}: fetching corp ${corpLabel} structures page 1`)
        const [firstPage, pagesHeader] = await corpStructures(access_token, corporation_id, 1)
        console.log(
          `[structures] ${ctx}: corp ${corpLabel} page 1 returned ${firstPage?.length ?? 0} rows, x-pages=${pagesHeader}`
        )
        all.push(...firstPage)
        const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
        for (let page = 2; page <= totalPages; page++) {
          console.log(`[structures] ${ctx}: fetching corp ${corpLabel} structures page ${page}/${totalPages}`)
          const [more] = await corpStructures(access_token, corporation_id, page)
          console.log(`[structures] ${ctx}: corp ${corpLabel} page ${page} returned ${more?.length ?? 0} rows`)
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
            `[structures] ${ctx}: upserting ${rows.length} structure row(s) for corp ${corpLabel} sample=${JSON.stringify(rows[0])}`
          )
          const { error: upsertErr, status: upsertStatus } = await sudoSupabase
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
          console.log(`[structures] ${ctx}: corp ${corpLabel} returned zero structures, nothing to upsert`)
        }

        const dt = Date.now() - t0
        console.log(`[structures] ${ctx}: done corp ${corpLabel} ${rows.length} fetched in ${dt}ms`)
      }

      if (!scope.includes(ASSETS_SCOPE)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} token lacks ${ASSETS_SCOPE}, skipping structure rigs`)
      } else if (seenAssetCorps.has(corporation_id)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} assets already pulled this run, skipping rigs`)
      } else {
        seenAssetCorps.add(corporation_id)
        try {
          // Our structures double as asset location_ids; only keep rigs fitted to them.
          const { data: ownStructures, error: ownErr } = await sudoSupabase
            .from('corp_structure')
            .select('structure_id')
            .eq('corporation_id', corporation_id)
          if (ownErr) throw ownErr
          const structureIds = new Set((ownStructures ?? []).map((s) => Number(s.structure_id)))

          const ta = Date.now()
          const assets = []
          console.log(`[structures] ${ctx}: fetching corp ${corpLabel} assets page 1`)
          const [firstAssetPage, assetPagesHeader] = await corpAssets(access_token, corporation_id, 1)
          assets.push(...firstAssetPage)
          const assetPages = Math.max(1, Number.parseInt(assetPagesHeader, 10) || 1)
          for (let page = 2; page <= assetPages; page++) {
            const [more] = await corpAssets(access_token, corporation_id, page)
            assets.push(...more)
          }
          console.log(
            `[structures] ${ctx}: corp ${corpLabel} returned ${assets.length} asset(s) across ${assetPages} page(s)`
          )

          const now = new Date().toISOString()

          // Replace this corp's asset snapshot wholesale (not SCD-2 like character
          // assets — corp inventories are large and IMPORTDATA only needs current state).
          const assetRows = assets.map((a) => ({
            item_id: a.item_id,
            corporation_id,
            type_id: a.type_id,
            location_id: a.location_id ?? null,
            location_flag: a.location_flag ?? null,
            location_type: a.location_type ?? null,
            quantity: a.quantity ?? null,
            is_singleton: a.is_singleton ?? null,
            is_blueprint_copy: a.is_blueprint_copy ?? null,
            updated_at: now,
          }))
          const { error: assetDelErr } = await sudoSupabase
            .from('corp_asset')
            .delete()
            .eq('corporation_id', corporation_id)
          if (assetDelErr) throw assetDelErr
          if (assetRows.length > 0) {
            const { error: assetErr } = await sudoSupabase.from('corp_asset').insert(assetRows)
            if (assetErr) throw assetErr
          }
          console.log(`[structures] ${ctx}: corp ${corpLabel} stored ${assetRows.length} corp_asset row(s)`)

          const rigRows = assets
            .filter((a) => isRigSlot(a.location_flag) && structureIds.has(Number(a.location_id)))
            .map((a) => ({
              structure_id: a.location_id,
              location_flag: a.location_flag,
              type_id: a.type_id,
              corporation_id,
              updated_at: now,
            }))

          // Replace this corp's rig rows wholesale so removed/swapped rigs don't linger.
          if (structureIds.size > 0) {
            const { error: delErr } = await sudoSupabase
              .from('corp_structure_rig')
              .delete()
              .eq('corporation_id', corporation_id)
            if (delErr) throw delErr
          }
          if (rigRows.length > 0) {
            const { error: rigErr } = await sudoSupabase
              .from('corp_structure_rig')
              .upsert(rigRows, { onConflict: 'structure_id,location_flag' })
            if (rigErr) throw rigErr
          }
          console.log(
            `[structures] ${ctx}: corp ${corpLabel} stored ${rigRows.length} structure rig(s) in ${Date.now() - ta}ms`
          )
        } catch (e) {
          console.error(`[structures] ${ctx}: corp ${corpLabel} rig pull FAILED name=${e?.name} message=${e?.message}`)
        }
      }

      if (!scope.includes(WALLET_SCOPE)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} token lacks ${WALLET_SCOPE}, skipping wallet journal`)
      } else if (seenWalletCorps.has(corporation_id)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} wallet journal already pulled this run, skipping`)
      } else {
        seenWalletCorps.add(corporation_id)
        await pullCorpWalletJournals({ access_token, corporation_id, ctx, corpLabel })
      }

      if (!scope.includes(JOBS_SCOPE)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} token lacks ${JOBS_SCOPE}, skipping industry jobs`)
      } else if (seenJobsCorps.has(corporation_id)) {
        console.log(`[structures] ${ctx}: corp ${corpLabel} industry jobs already pulled this run, skipping`)
      } else {
        seenJobsCorps.add(corporation_id)
        try {
          const tj = Date.now()
          const jobs = []
          console.log(`[structures] ${ctx}: fetching corp ${corpLabel} industry jobs page 1`)
          const [firstJobPage, jobPagesHeader] = await corpIndustryJobs(access_token, corporation_id, 1)
          jobs.push(...firstJobPage)
          const jobPages = Math.max(1, Number.parseInt(jobPagesHeader, 10) || 1)
          for (let page = 2; page <= jobPages; page++) {
            const [more] = await corpIndustryJobs(access_token, corporation_id, page)
            jobs.push(...more)
          }
          console.log(
            `[structures] ${ctx}: corp ${corpLabel} returned ${jobs.length} industry job(s) across ${jobPages} page(s)`
          )

          const now = new Date().toISOString()
          const jobRows = jobs.map((j) => ({
            job_id: j.job_id,
            corporation_id,
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
            seen_at: now,
          }))
          if (jobRows.length > 0) {
            const { error: jobErr } = await sudoSupabase
              .from('corp_industry_job')
              .upsert(jobRows, { onConflict: 'job_id' })
            if (jobErr) throw jobErr
          }
          console.log(
            `[structures] ${ctx}: corp ${corpLabel} stored ${jobRows.length} industry job(s) in ${Date.now() - tj}ms`
          )
        } catch (e) {
          console.error(
            `[structures] ${ctx}: corp ${corpLabel} industry jobs pull FAILED name=${e?.name} message=${e?.message}`
          )
        }
      }
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[structures] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }

  // Cache names for the journal parties we just pulled (industry-tax payers etc.) so the structures
  // page shows who paid instead of a raw id. Doing it here keeps names within an hour of the journal
  // rather than waiting on the once-a-day job.
  try {
    await resolveCorpJournalNames()
  } catch (e) {
    console.error(`[structures] name resolution FAILED name=${e?.name} message=${e?.message}`)
  }

  // Name the foreign player structures characters hold assets in (own-corp ones are
  // already covered by corp_structure above), so the assets page can label them.
  try {
    await resolveStructureNames()
  } catch (e) {
    console.error(`[structures] structure-name resolution FAILED name=${e?.name} message=${e?.message}`)
  }

  // Name the NPC stations characters hold assets in, so the assets page can label
  // them instead of showing a raw station id (player structures are named above).
  try {
    await resolveAssetStationNames()
  } catch (e) {
    console.error(`[structures] station-name resolution FAILED name=${e?.name} message=${e?.message}`)
  }

  // Name the solar systems our corp structures sit in, so the structures page can
  // label each tile's system instead of falling back to a raw system_id.
  try {
    await resolveCorpStructureSystemNames()
  } catch (e) {
    console.error(`[structures] system-name resolution FAILED name=${e?.name} message=${e?.message}`)
  }
}

const execute = async () => {
  try {
    await runStructures()
  } catch (e) {
    console.error('[structures] FAILED', e)
    process.exit(1)
  }
}

// Only run as a CLI (npm run structures / the scheduled workflow) when invoked
// directly. When imported by the Next.js queue consumer, the top-level run must not fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  execute()
}
