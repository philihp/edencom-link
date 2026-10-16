import { readFileSync } from 'node:fs'

import { chain, filter, fromPairs, groupBy, map, partition, pipe, pluck, prop, splitEvery, uniq } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { parseRigList, rigSlotRows, structureFullName, stubStructureId, toServices } from './gezSheet.js'
import { forEachSequential } from './lib.js'

// One-off import: the "GEZ Rig List" tab of Goonswarm's public GEZ Tracker
// sheet → stub rows in corp_structure + corp_structure_rig, so the rig-aware
// tools (MCP rigs_for_blueprint, the structure_id bonus resolver, /structure)
// know what the alliance's economic-zone structures are fitted with.
//
//   pnpm run import-gez-structures -- [--csv <file>] [--corporation <id>] [--dry-run]
//
// Without --csv the tab is fetched from the sheet's public CSV export. Each
// structure is matched to universe_structure by "<system> - <name>" and hull;
// a match keeps its real id (and owner, when known), otherwise the structure
// gets a deterministic synthetic id (gezSheet.js). Unowned rows go to
// --corporation (default GSF Logistics and Posting Reserves, which holds most
// GEZ structures we have resolved). A structure a director scan already put in
// corp_structure is left alone — scanned data always wins. Re-running upserts
// the same rows.

const SHEET_CSV =
  'https://docs.google.com/spreadsheets/d/1kbY0SQmz_csAzTSyt_0G6cz9kiSSORY8xKYVzbMKZnI/gviz/tq?tqx=out:csv&sheet=GEZ%20Rig%20List'
const DEFAULT_CORPORATION_ID = 98718076
const BATCH = 200

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const dryRun = args.includes('--dry-run')
const fallbackCorporationId = Number(flag('--corporation') ?? DEFAULT_CORPORATION_ID)

const readSheet = async () => {
  const path = flag('--csv')
  if (path) return readFileSync(path, 'utf8')
  const res = await fetch(SHEET_CSV)
  if (!res.ok) throw new Error(`fetching the GEZ sheet failed: ${res.status}`)
  return res.text()
}

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

// name → id over an SDE view, in chunks (the IN list rides in the URL).
const idsByName = async (table, idColumn, names) => {
  const rows = []
  await forEachSequential(splitEvery(100, uniq(names)), async (chunk) => {
    const data = must(await sudoSupabase.from(table).select(`${idColumn}, name`).in('name', chunk), table)
    rows.push(...data)
  })
  return fromPairs(map((r) => [r.name, Number(r[idColumn])], rows))
}

const run = async () => {
  const sheet = parseRigList(await readSheet())
  console.log(`[import-gez-structures] ${sheet.length} structures in the sheet`)

  const systemIds = await idsByName('sde_kspace_system', 'system_id', pluck('system', sheet))
  const typeIds = await idsByName('sde_named_type', 'type_id', [...pluck('hull', sheet), ...chain(prop('rigs'), sheet)])

  const known = must(
    await sudoSupabase
      .from('universe_structure')
      .select('structure_id, name, type_id, owner_corporation_id')
      .in('system_id', uniq(Object.values(systemIds))),
    'universe_structure'
  )
  const realByName = groupBy((s) => `${s.name.toLowerCase()}|${s.type_id}`, known)

  const problems = []
  const resolved = pipe(
    map((row) => {
      const systemId = systemIds[row.system]
      const hullTypeId = typeIds[row.hull]
      if (!systemId || !hullTypeId) {
        problems.push(`${row.system} / ${row.name}: unknown ${systemId ? `hull "${row.hull}"` : 'system'}, skipped`)
        return null
      }
      const fullName = structureFullName(row.system, row.name)
      const real = realByName[`${fullName.toLowerCase()}|${hullTypeId}`]?.[0]
      const missingRigs = filter((r) => !typeIds[r], row.rigs)
      if (missingRigs.length) problems.push(`${fullName}: unknown rig(s) ${missingRigs.join('; ')}`)
      const { services, unknown } = toServices(row.services)
      if (unknown.length) problems.push(`${fullName}: unmapped service(s) ${unknown.join('; ')}`)
      const structureId = real ? Number(real.structure_id) : stubStructureId(systemId, hullTypeId, row.name)
      const corporationId = Number(real?.owner_corporation_id ?? fallbackCorporationId)
      return {
        structure: {
          structure_id: structureId,
          corporation_id: corporationId,
          type_id: hullTypeId,
          system_id: systemId,
          name: real?.name ?? fullName,
          state: 'online',
          services,
        },
        rigs: rigSlotRows(
          structureId,
          corporationId,
          map(
            (r) => typeIds[r],
            filter((r) => typeIds[r], row.rigs)
          )
        ),
        matched: Boolean(real),
      }
    }),
    filter(Boolean)
  )(sheet)

  const scanned = new Set(
    map(
      (r) => Number(r.structure_id),
      must(
        await sudoSupabase
          .from('corp_structure')
          .select('structure_id')
          .in(
            'structure_id',
            map((r) => r.structure.structure_id, resolved)
          ),
        'corp_structure'
      )
    )
  )
  // A real id already in corp_structure came from a director scan (or an
  // earlier run of this import, for a matched id — harmless to skip either way).
  const [skipped, toWrite] = partition((r) => r.matched && scanned.has(r.structure.structure_id), resolved)

  console.log(
    `[import-gez-structures] ${toWrite.length} to write (${filter(prop('matched'), toWrite).length} matched to a real id), ` +
      `${skipped.length} already scanned, ${chain(prop('rigs'), toWrite).length} rigs`
  )
  problems.forEach((p) => console.warn(`[import-gez-structures] ${p}`))

  if (dryRun) {
    toWrite.forEach(({ structure, rigs }) =>
      console.log(`  ${structure.structure_id}\t${structure.corporation_id}\t${structure.name}\t${rigs.length} rig(s)`)
    )
    return
  }

  await forEachSequential(splitEvery(BATCH, toWrite), async (batch) => {
    must(
      await sudoSupabase.from('corp_structure').upsert(map(prop('structure'), batch), { onConflict: 'structure_id' }),
      'corp_structure upsert'
    )
    const ids = map((r) => r.structure.structure_id, batch)
    // Replace each structure's rigs, so a slot the sheet emptied doesn't linger.
    must(await sudoSupabase.from('corp_structure_rig').delete().in('structure_id', ids), 'corp_structure_rig delete')
    const rigs = chain(prop('rigs'), batch)
    if (rigs.length)
      must(
        await sudoSupabase.from('corp_structure_rig').upsert(rigs, { onConflict: 'structure_id,location_flag' }),
        'corp_structure_rig upsert'
      )
  })
  console.log('[import-gez-structures] done')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
