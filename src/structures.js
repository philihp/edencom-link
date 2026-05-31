import { pullCorpWalletJournals } from './corpWalletJournal.js'
import { character as fetchCharacter, corpAssets, corpStructures, corpWalletJournal, universeNames } from './esi.js'
import { sudoSupabase } from './supabase.js'
import { refreshAccessToken } from './tokenRefresh.js'

const STRUCTURES_SCOPE = 'esi-corporations.read_structures.v1'
const WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1'
const ASSETS_SCOPE = 'esi-assets.read_corporation_assets.v1'

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

const execute = async () => {
  const { data: characters, error: charactersError } = await sudoSupabase
    .schema('hangar')
    .from('character')
    .select('id, name')
  if (charactersError) {
    console.error('[structures] character lookup failed:', charactersError)
    process.exit(1)
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))

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
    const name = characterName.get(t.character_id) ?? '?'
    console.log(
      `[structures]   token ${t.id} character ${name} (${t.character_id}) refresh ...${tail(t.refresh_token)}`
    )
  }

  const seenStructureCorps = new Set()
  const seenWalletCorps = new Set()
  const seenAssetCorps = new Set()
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
            .schema('hangar')
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
              .schema('hangar')
              .from('corp_structure_rig')
              .delete()
              .eq('corporation_id', corporation_id)
            if (delErr) throw delErr
          }
          if (rigRows.length > 0) {
            const { error: rigErr } = await sudoSupabase
              .schema('hangar')
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
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[structures] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }
}

execute()
