import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getSystemJumpGraph } from '@/sdeJumps'
import { TEMPERATE_PLANET_TYPE_ID, getSdePlanets, getSystemPlanets } from '@/sdePlanets'
import { getSdeSystems, searchSdeSystems } from '@/sdeSystems'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

import { Countdown } from './countdown'
import CopyDiscordPing from './copyDiscordPing'
import { formatDuration, formatUtc } from './duration'
import EnemyDenIntel, { type EnemyDenIntelRow } from './enemyDenIntel'
import { layout, neighbourhood } from './graph'
import ShareAlliance from './shareAlliance'
import { Topology, type NodeColor, type TopologyNode } from './topology'
import styles from './mercenaryDens.module.css'

export const dynamic = 'force-dynamic'

// A den we can see in the DB — our own, plus dens shared to one of our alliances
// (RLS on character_mercenary_den only ever surfaces those). So every DB den is
// "ours" for colouring purposes; an enemy den is never here, it is reported by
// hand into mercenary_den_enemy_intel.
type DenRow = {
  registration_id: string
  planet_id: number
  state: string | null
  development_level: string | null
  development_amount: number | null
  anarchy_level: string | null
  anarchy_amount: number | null
  infomorphs: number | null
  reinforcement_end: string | null
  status_observed_at: string | null
}

type MergedRow = {
  system: string
  systemID: number | null
  planet: string // roman numeral
  celestialIndex: number | null
  den: DenRow & { ownerLabel: string; ownerCharacterId: string | null }
}

const isReinforced = (row: MergedRow): boolean =>
  row.den.reinforcement_end != null && new Date(row.den.reinforcement_end).getTime() > Date.now()

// Reinforced (red) wins; otherwise a den we can see is one of ours (green).
// Yellow is the map's third tint and belongs to a system we hold no den in but
// have an enemy sighting for — a node colour rather than a row colour.
const colorOf = (row: MergedRow): NodeColor => (isReinforced(row) ? 'red' : 'green')

// How far out from a den the map draws, and how many systems it may hold. One
// jump is the ring a den's defence actually cares about; the cap keeps the
// per-system planet lookup inside one PostgREST page.
const MAP_JUMPS = 1
const MAX_MAP_SYSTEMS = 80

const MercenaryDensPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // The caller's characters, to label/scope their own dens.
  const { data: myRegs } = await supabase
    .from('registration')
    .select('id, name, character_id, corporation_id, is_main')
    .order('is_main', { ascending: false })
  const ownRegById = new Map(
    (myRegs ?? []).map((r) => [
      r.id as string,
      { name: r.name as string, characterId: r.character_id != null ? String(r.character_id) : null },
    ])
  )

  // The alliances the caller has a character in — the audiences they can share
  // with, and everything the picker offers (usually just the one). Resolved
  // registration → corporation → alliance; both directory tables are
  // world-readable, and this mirrors the my_alliance_ids() SQL helper the
  // sharing policies use.
  const ownCorpIds = [...new Set((myRegs ?? []).map((r) => r.corporation_id).filter((c): c is number => c != null))]
  const { data: myCorps } = ownCorpIds.length
    ? await supabase.from('corporation').select('corporation_id, alliance_id').in('corporation_id', ownCorpIds)
    : { data: [] }
  const allianceIds = [...new Set((myCorps ?? []).map((c) => c.alliance_id).filter((a): a is number => a != null))]
  const { data: myAlliances } = allianceIds.length
    ? await supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds)
    : { data: [] }
  const alliances = (myAlliances ?? []).map((a) => ({
    id: String(a.alliance_id),
    name: a.name ?? `Alliance #${a.alliance_id}`,
  }))

  // Which of those the caller currently shares with. Sharing is opt-in — no rows
  // means shared with nobody — and the rows are per registration, while the UI
  // is one choice for the whole account, so an alliance counts as ticked when
  // any of the caller's characters shares with it (which is how the action
  // writes them: all characters at once).
  const registrationIds = [...ownRegById.keys()]
  const { data: shares } = registrationIds.length
    ? await supabase.from('character_mercenary_den_share').select('alliance_ids').in('registration_id', registrationIds)
    : { data: [] }
  const sharedAllianceIds = [
    ...new Set(
      ((shares ?? []) as Array<{ alliance_ids: Array<number | string> | null }>).flatMap((s) =>
        (s.alliance_ids ?? []).map(String)
      )
    ),
  ]

  // Every mercenary den we can see (own + shared to one of our alliances), each
  // enriched with its latest observed status (the view left-joins it).
  const { data: denData } = await supabase.from('character_mercenary_den').select('*')
  const dens = (denData ?? []) as DenRow[]

  // Resolve owner identity for dens we can see but don't own (shared to one of
  // our alliances). Their registration is hidden from us by RLS, but
  // character_directory carries the public half of the same identity — name and
  // EVE character id, keyed by registration and deliberately free of user_id —
  // and is world-readable, so this is a plain join rather than a definer bridge.
  // Without it a shared den would show only "Corpmate".
  const denOwnerById = new Map(ownRegById)
  const foreignOwnerIds = [...new Set(dens.map((d) => d.registration_id))].filter((id) => !denOwnerById.has(id))
  if (foreignOwnerIds.length) {
    const { data: owners } = await supabase
      .from('character_directory')
      .select('registration_id, name, character_id')
      .in('registration_id', foreignOwnerIds)
    for (const o of (owners ?? []) as { registration_id: string; name: string; character_id: number | null }[]) {
      denOwnerById.set(o.registration_id, {
        name: o.name,
        characterId: o.character_id != null ? String(o.character_id) : null,
      })
    }
  }

  // Hand-submitted enemy-den sightings — a submitter always sees their own, and
  // sees others' reports exactly when that submitter's dens are visible to them
  // (mercenary_den_enemy_intel's RLS resolves through the same share rows as
  // real dens). Soonest reinforcement timer first. Only rows
  // whose reinforcement timer is still in the future or expired less than an
  // hour ago are shown (long-stale and undated rows drop off), and soft-deleted
  // rows (deleted_at set) are hidden.
  const reinforcementCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: intelData } = await supabase
    .from('mercenary_den_enemy_intel')
    .select('*')
    .is('deleted_at', null)
    .gt('reinforcement_end', reinforcementCutoff)
    .order('reinforcement_end', { ascending: true })
  const enemyDenIntel: EnemyDenIntelRow[] = (intelData ?? []).map((row) => ({
    id: row.id,
    system: row.system,
    planet: row.planet,
    owner: row.owner,
    reinforcementEnd: row.reinforcement_end,
    notes: row.notes,
    reportedBy: row.reported_by,
    createdAt: row.created_at,
    mine: row.created_by === user.id,
  }))
  const defaultReportedBy = [...ownRegById.values()][0]?.name ?? ''
  // Reinforcement time input defaults to 24h out (a den reinforces for roughly a
  // day), date only — "YYYY-MM-DDT" — so the reporter just fills in the hh:mm:ss.
  // Computed on the server so the client's initial state matches (no hydration
  // mismatch) — the value is a plain string the client edits.
  const defaultReinforcementEnd = `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T`

  // One row per den we can see, keyed by the planet it sits on. A den's
  // planet_id resolves to (system, roman) through the nightly-mirrored SDE
  // (src/sdePlanets.ts) — one bulk lookup for every den up front, so the loop
  // below stays a sync record read.
  const planetsById = await getSdePlanets(dens.map((d) => d.planet_id))
  const rows: MergedRow[] = dens
    .map((den) => {
      const planet = planetsById[den.planet_id] ?? null
      const ownReg = denOwnerById.get(den.registration_id)
      return {
        system: planet?.systemName ?? `Planet #${den.planet_id}`,
        systemID: planet?.systemID ?? null,
        planet: planet?.roman ?? '',
        celestialIndex: planet?.celestialIndex ?? null,
        den: {
          ...den,
          ownerLabel: ownReg?.name ?? 'Corpmate',
          // The EVE character id, shown in parens after the owner. Resolvable
          // for the caller's own characters and for shared dens' owners (via
          // the character_directory lookup above); "Corpmate" only survives if
          // resolution somehow fails.
          ownerCharacterId: ownReg?.characterId ?? null,
        },
      }
    })
    .sort((a, b) => a.system.localeCompare(b.system) || (a.celestialIndex ?? 0) - (b.celestialIndex ?? 0))

  // A sighting names its system as free text, so resolve each one through the
  // SDE search and keep it only when it names a system exactly (case aside).
  // An unrecognised name still shows in the intel table — it just can't be put
  // on the map.
  const intelSystemNames = [...new Set(enemyDenIntel.map((r) => r.system?.trim()).filter((s): s is string => !!s))]
  const intelSystemIDs = (
    await Promise.all(
      intelSystemNames.map(async (name) => {
        const hits = await searchSdeSystems(name, 5)
        return hits.find((hit) => hit.name.toUpperCase() === name.toUpperCase())?.systemID ?? null
      })
    )
  ).filter((id): id is number => id != null)

  // The map draws itself around the data: every system holding a den we can
  // see or carrying a sighting, plus everything one stargate out from those,
  // linked and positioned from the mirrored SDE (stargate graph + real
  // coordinates). Nothing about it is hand-maintained, so an account whose
  // dens move — or whose front line is somewhere else entirely — gets its own
  // map rather than one curated region's.
  const seedSystemIDs = [
    ...new Set([...rows.map((r) => r.systemID).filter((id): id is number => id != null), ...intelSystemIDs]),
  ]
  const { systemIDs: mapSystemIDs, edges } = neighbourhood(
    seedSystemIDs,
    await getSystemJumpGraph(),
    MAP_JUMPS,
    MAX_MAP_SYSTEMS
  )
  const mapSystems = await getSdeSystems(mapSystemIDs)

  // A globe per temperate planet under each node — the planets a den can sit
  // on, counted from the SDE rather than from a kept list.
  const temperateCounts = (await getSystemPlanets(mapSystemIDs))
    .filter((planet) => planet.typeID === TEMPERATE_PLANET_TYPE_ID)
    .reduce<Record<number, number>>((counts, planet) => {
      counts[planet.systemID] = (counts[planet.systemID] ?? 0) + 1
      return counts
    }, {})

  // Node colour per system: the most severe colour among that system's dens
  // (red > green), or yellow where we hold no den but a sighting names the
  // system. Sighted systems also take a dashed red outline on top of the tint.
  const severity: Record<NodeColor, number> = { red: 3, yellow: 2, green: 1 }
  const nodeColors = rows.reduce<Record<number, NodeColor>>((colors, row) => {
    if (row.systemID == null) return colors
    const color = colorOf(row)
    const current = colors[row.systemID]
    if (!current || severity[color] > severity[current]) colors[row.systemID] = color
    return colors
  }, {})
  const enemyIntelSystemIDs = new Set(intelSystemIDs)

  // The galaxy's own geometry, flattened to the top-down plane the in-game
  // star map draws on (x/z; y is galactic "up"). A system the mirror has no
  // position for falls back on the origin, where the layout's spreading pass
  // still finds it a spot rather than dropping it off the map.
  const {
    positions,
    viewBox,
    width: mapWidth,
    height: mapHeight,
  } = layout(
    mapSystemIDs.map((systemID) => ({
      systemID,
      x: mapSystems[systemID]?.position?.x ?? 0,
      y: mapSystems[systemID]?.position?.z ?? 0,
    })),
    edges
  )
  const nodes: TopologyNode[] = mapSystemIDs.map((systemID) => ({
    systemID,
    name: mapSystems[systemID]?.name ?? `#${systemID}`,
    ...positions[systemID],
    temperate: temperateCounts[systemID] ?? 0,
    color: nodeColors[systemID] ?? (enemyIntelSystemIDs.has(systemID) ? 'yellow' : null),
    enemyIntel: enemyIntelSystemIDs.has(systemID),
  }))

  const dash = <span className={styles.empty}>—</span>
  const evolution = (level: string | null, amount: number | null) =>
    level != null ? `${level}${amount != null ? ` (${amount})` : ''}` : dash

  // One render-time reference point for the countdown/elapsed cells, so every
  // row is measured against the same instant.
  const now = Date.now()

  return (
    <>
      <div className={styles.pageHeader}>
        {/* The header nav no longer carries this page — it's reached from /structure. */}
        <Link href="/structure" className={styles.backLink}>
          &laquo; Structures
        </Link>
        <h1>Mercenary Dens</h1>
        <ShareAlliance alliances={alliances} sharedAllianceIds={sharedAllianceIds} />
      </div>

      {nodes.length > 0 ? (
        <Topology nodes={nodes} edges={edges} viewBox={viewBox} width={mapWidth} height={mapHeight} />
      ) : (
        <p className={styles.subtitle}>
          The map draws itself around your dens and the systems your sightings name — nothing to draw yet.
        </p>
      )}

      <h2>Friendly dens</h2>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>System</th>
              <th>Planet</th>
              <th>Owner</th>
              <th>State</th>
              <th>Development</th>
              <th>Anarchy</th>
              <th>Infomorphs</th>
              <th>Reinforced</th>
              <th>Observed At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const den = row.den
              return (
                <tr key={`${row.system}-${row.planet}-${i}`} className={styles[`row_${colorOf(row)}`]}>
                  <td className={styles.system}>{row.system}</td>
                  <td className={styles.planet}>{row.planet || dash}</td>
                  <td>
                    {den.ownerLabel}
                    {den.ownerCharacterId ? <span className={styles.alliance}> ({den.ownerCharacterId})</span> : null}
                  </td>
                  <td>{den.state ?? dash}</td>
                  <td>{evolution(den.development_level, den.development_amount)}</td>
                  <td>{evolution(den.anarchy_level, den.anarchy_amount)}</td>
                  <td>{den.infomorphs ?? dash}</td>
                  <td>
                    {isReinforced(row) ? (
                      <>
                        <span className={styles.reinforced}>
                          reinforced
                          {den.reinforcement_end ? (
                            <>
                              {' '}
                              <Countdown end={den.reinforcement_end} now={now} />
                            </>
                          ) : null}
                        </span>
                        {den.reinforcement_end ? (
                          <>
                            <span className={styles.timestamp}> {formatUtc(den.reinforcement_end)}</span>
                            <CopyDiscordPing
                              system={row.system}
                              planet={row.planet}
                              reinforcementEnd={den.reinforcement_end}
                              enemy={false}
                            />
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className={styles.stable}>stable</span>
                    )}
                  </td>
                  <td>
                    {den.status_observed_at ? (
                      <>
                        {formatDuration(now - new Date(den.status_observed_at).getTime())} ago
                        <span className={styles.timestamp}> {formatUtc(den.status_observed_at)}</span>
                      </>
                    ) : (
                      dash
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <EnemyDenIntel
        rows={enemyDenIntel}
        defaultReportedBy={defaultReportedBy}
        defaultReinforcementEnd={defaultReinforcementEnd}
        now={now}
      />
    </>
  )
}
export default MercenaryDensPage
