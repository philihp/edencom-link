import { chain, filter, fromPairs, map, pluck, prop, uniq } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { rigSlotRows } from './gezSheet.js'
import { INFERRED_STRUCTURES, STUB_REKEYS, inferredProblems, owners, toServiceRows } from './inferredStructures.js'
import { forEachSequential } from './lib.js'
import { maintainStructureShareDefault } from './structureShareDefault.js'

// Writes src/jobs/inferredStructures.js into corp_structure + corp_structure_rig
// — the hand-inferred fittings of structures our jobs run in but nobody scans,
// and the GEZ stubs re-keyed onto their real ids. The second one-off beside
// importGezStructures.js, with the same rules: scanned data always wins, and
// a re-run upserts the same rows.
//
//   pnpm run import-inferred-structures -- [--dry-run]
//
// A row a director scan wrote is recognised by reinforce_hour, which ESI
// always sends and no import ever does; such a structure is left alone. The
// hull, system and owner-as-the-directory-knows-it come from
// universe_structure, so the table carries names for people and ids for the
// database and nothing is typed twice. Each owner gets its `corporation` row
// and the seeded alliance structure share the corp-structures extract would
// have given it on a first scan (structureShareDefault.js): without that,
// corp_structure's RLS shows these rows to the owner's own members only.

const TAG = 'import-inferred-structures'
const dryRun = process.argv.includes('--dry-run')

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

const byId = (rows, key) => fromPairs(map((r) => [String(r[key]), r], rows))

const run = async () => {
  const problems = inferredProblems(INFERRED_STRUCTURES)
  if (problems.length) throw new Error(`the table has problems:\n  ${problems.join('\n  ')}`)

  const rigNames = uniq(chain(prop('rigs'), INFERRED_STRUCTURES))
  const rigTypes = byId(
    must(await sudoSupabase.from('sde_named_type').select('type_id, name').in('name', rigNames), 'sde_named_type'),
    'name'
  )
  const unknownRigs = filter((n) => !rigTypes[n], rigNames)
  if (unknownRigs.length) throw new Error(`rigs the SDE does not name: ${unknownRigs.join('; ')}`)

  const structureIds = [...pluck('structureId', INFERRED_STRUCTURES), ...pluck('structureId', STUB_REKEYS)]
  const directory = byId(
    must(
      await sudoSupabase
        .from('universe_structure')
        .select('structure_id, name, system_id, type_id, owner_corporation_id')
        .in('structure_id', structureIds),
      'universe_structure'
    ),
    'structure_id'
  )
  const existing = byId(
    must(
      await sudoSupabase
        .from('corp_structure')
        .select('structure_id, corporation_id, reinforce_hour, services')
        .in('structure_id', [...structureIds, ...pluck('stubId', STUB_REKEYS)]),
      'corp_structure'
    ),
    'structure_id'
  )
  const scanned = (id) => existing[String(id)]?.reinforce_hour != null

  const now = new Date().toISOString()

  // ── Owners: corporation rows and the seeded alliance share ───────────────
  if (!dryRun) {
    await forEachSequential(owners(), async (o) => {
      must(
        await sudoSupabase
          .from('corporation')
          .upsert(
            { corporation_id: o.corporationId, name: o.name, alliance_id: o.allianceId, updated_at: now },
            { onConflict: 'corporation_id' }
          ),
        'corporation upsert'
      )
      await maintainStructureShareDefault(TAG, o.corporationId)
    })
  }

  // ── Stub re-keys ─────────────────────────────────────────────────────────
  await forEachSequential(STUB_REKEYS, async (rekey) => {
    const stub = existing[String(rekey.stubId)]
    const real = directory[String(rekey.structureId)]
    if (!stub) {
      console.log(`[${TAG}] ${rekey.name}: stub ${rekey.stubId} already gone`)
      return
    }
    if (!real) throw new Error(`${rekey.name}: ${rekey.structureId} is not in universe_structure`)
    if (scanned(rekey.structureId)) {
      console.log(`[${TAG}] ${rekey.name}: scanned by a director, stub ${rekey.stubId} dropped unread`)
    }
    const corporationId = rekey.owner?.corporationId ?? Number(stub.corporation_id)
    const stubRigs = must(
      await sudoSupabase.from('corp_structure_rig').select('location_flag, type_id').eq('structure_id', rekey.stubId),
      'corp_structure_rig'
    )
    console.log(`[${TAG}] ${rekey.name}: ${rekey.stubId} -> ${rekey.structureId}, ${stubRigs.length} rig(s)`)
    if (dryRun) return

    if (!scanned(rekey.structureId)) {
      must(
        await sudoSupabase.from('corp_structure').upsert(
          {
            structure_id: rekey.structureId,
            corporation_id: corporationId,
            type_id: Number(real.type_id),
            system_id: Number(real.system_id),
            name: real.name,
            state: 'online',
            services: stub.services,
            last_seen_at: now,
            updated_at: now,
          },
          { onConflict: 'structure_id' }
        ),
        'corp_structure upsert'
      )
      must(
        await sudoSupabase.from('corp_structure_rig').delete().eq('structure_id', rekey.structureId),
        'corp_structure_rig delete'
      )
      if (stubRigs.length)
        must(
          await sudoSupabase.from('corp_structure_rig').upsert(
            map(
              (r) => ({
                structure_id: rekey.structureId,
                location_flag: r.location_flag,
                type_id: r.type_id,
                corporation_id: corporationId,
                updated_at: now,
              }),
              stubRigs
            ),
            { onConflict: 'structure_id,location_flag' }
          ),
          'corp_structure_rig upsert'
        )
    }
    must(await sudoSupabase.from('corp_structure_rig').delete().eq('structure_id', rekey.stubId), 'stub rig delete')
    must(await sudoSupabase.from('corp_structure').delete().eq('structure_id', rekey.stubId), 'stub delete')
  })

  // ── Inferred fittings ────────────────────────────────────────────────────
  await forEachSequential(INFERRED_STRUCTURES, async (row) => {
    const real = directory[String(row.structureId)]
    if (!real) throw new Error(`${row.name}: ${row.structureId} is not in universe_structure`)
    if (scanned(row.structureId)) {
      console.log(`[${TAG}] ${row.name}: scanned by a director, left alone`)
      return
    }
    const rigs = rigSlotRows(
      row.structureId,
      row.owner.corporationId,
      map((name) => Number(rigTypes[name].type_id), row.rigs)
    )
    console.log(
      `[${TAG}] ${row.name}: ${row.services.length} service(s), ${rigs.length} rig(s)` +
        (row.ownerGuessed ? ` (owner guessed: ${row.owner.name})` : '')
    )
    if (dryRun) return

    must(
      await sudoSupabase.from('corp_structure').upsert(
        {
          structure_id: row.structureId,
          corporation_id: row.owner.corporationId,
          type_id: Number(real.type_id),
          system_id: Number(real.system_id),
          name: real.name,
          state: 'online',
          services: toServiceRows(row.services),
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: 'structure_id' }
      ),
      'corp_structure upsert'
    )
    // Replace the structure's rigs, so a slot the table emptied doesn't linger.
    must(
      await sudoSupabase.from('corp_structure_rig').delete().eq('structure_id', row.structureId),
      'corp_structure_rig delete'
    )
    if (rigs.length)
      must(
        await sudoSupabase.from('corp_structure_rig').upsert(
          map((r) => ({ ...r, updated_at: now }), rigs),
          { onConflict: 'structure_id,location_flag' }
        ),
        'corp_structure_rig upsert'
      )
  })

  console.log(`[${TAG}] ${dryRun ? 'dry run, nothing written' : 'done'}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
