import { redirect } from 'next/navigation'

import { getSdePlanets } from '@/sdePlanets'
import { createClient } from '@/utils/supabase/server'

import { Countdown } from './countdown'
import CopyDiscordPing from './copyDiscordPing'
import { TEMPERATE_PLANETS } from './data'
import { formatDuration, formatUtc } from './duration'
import EnemyDenIntel, { type EnemyDenIntelRow } from './enemyDenIntel'
import ShareAlliance from './shareAlliance'
import { Topology, type NodeColor } from './topology'
import styles from './mercenaryDens.module.css'

export const dynamic = 'force-dynamic'

// A den we can see in the DB — our own, plus dens shared to one of our alliances
// (RLS on character_mercenary_den only ever surfaces those). So every DB den is
// "ours" for colouring purposes; external dens come only from the hand-kept
// intel.
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
  planet: string // roman numeral
  intel?: { owner: string; alliance: string | null; reinforced: boolean }
  den?: DenRow & { ownerLabel: string; ownerCharacterId: string | null }
}

const isReinforced = (row: MergedRow): boolean =>
  row.den?.reinforcement_end != null && new Date(row.den.reinforcement_end).getTime() > Date.now()
    ? true
    : (row.intel?.reinforced ?? false)

// Reinforced (red) wins; then our own/corp den (green); then external intel
// (yellow); an empty temperate planet has no colour.
const colorOf = (row: MergedRow): NodeColor | null => {
  if (isReinforced(row)) return 'red'
  if (row.den) return 'green'
  if (row.intel) return 'yellow'
  return null
}

const MercenaryDensPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
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
    ? await supabase.from('character_mercenary_den_share').select('alliance_id').in('character_id', registrationIds)
    : { data: [] }
  const sharedAllianceIds = [...new Set((shares ?? []).map((s) => String(s.alliance_id)))]

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
    mine: row.created_by === data.user.id,
  }))
  const defaultReportedBy = [...ownRegById.values()][0]?.name ?? ''
  // Reinforcement time input defaults to 24h out (a den reinforces for roughly a
  // day), date only — "YYYY-MM-DDT" — so the reporter just fills in the hh:mm:ss.
  // Computed on the server so the client's initial state matches (no hydration
  // mismatch) — the value is a plain string the client edits.
  const defaultReinforcementEnd = `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T`

  // Merge the hand-maintained temperate-planet intel with our real dens, keyed by
  // system + roman numeral. A den's planet_id is resolved to (system, roman) via
  // the nightly-mirrored SDE (src/sdePlanets.ts); dens on a planet not in the
  // static list are appended as extra rows. One bulk lookup for every den's
  // planet up front, so the merge loop below stays a sync record read.
  const planetsById = await getSdePlanets(dens.map((d) => d.planet_id))
  const rowsByKey = new Map<string, MergedRow>()
  const key = (system: string, planet: string) => `${system}|${planet}`

  for (const { system, planet, den } of TEMPERATE_PLANETS) {
    rowsByKey.set(key(system, planet), { system, planet, intel: den ?? undefined })
  }

  for (const den of dens) {
    const planet = planetsById[den.planet_id] ?? null
    const system = planet?.systemName ?? ''
    const roman = planet?.roman ?? ''
    const ownReg = denOwnerById.get(den.registration_id)
    const enriched = {
      ...den,
      ownerLabel: ownReg?.name ?? 'Corpmate',
      // The EVE character id, shown in parens after the owner. Resolvable for
      // the caller's own characters and for shared dens' owners (via the
      // character_directory lookup above); "Corpmate" only survives if
      // resolution somehow fails.
      ownerCharacterId: ownReg?.characterId ?? null,
    }
    const k = key(system, roman)
    const existing = rowsByKey.get(k)
    if (existing) {
      existing.den = enriched
    } else {
      rowsByKey.set(k, { system: system || `Planet #${den.planet_id}`, planet: roman, den: enriched })
    }
  }

  // Static planets first (in their curated outward-from-staging order), then any
  // appended den-only rows sorted by system/planet.
  const staticKeys = new Set(TEMPERATE_PLANETS.map(({ system, planet }) => key(system, planet)))
  const staticRows = TEMPERATE_PLANETS.map(({ system, planet }) => rowsByKey.get(key(system, planet))!)
  const extraRows = [...rowsByKey.entries()]
    .filter(([k]) => !staticKeys.has(k))
    .map(([, row]) => row)
    .sort((a, b) => a.system.localeCompare(b.system) || a.planet.localeCompare(b.planet))
  // Drop planets with neither a den nor intel — an empty row has nothing to show.
  const rows = [...staticRows, ...extraRows].filter((row) => row.den || row.intel)

  // Node colour per system: the most severe colour among that system's rows
  // (red > yellow > green).
  const severity: Record<NodeColor, number> = { red: 3, yellow: 2, green: 1 }
  const nodeColors: Record<string, NodeColor> = {}
  for (const row of rows) {
    const c = colorOf(row)
    if (!c) continue
    const cur = nodeColors[row.system]
    if (!cur || severity[c] > severity[cur]) nodeColors[row.system] = c
  }

  // Systems with a reported enemy-den sighting get a dashed red outline on the
  // topology, on top of whatever den-status tint they already have. Matched by
  // name against the node keys, upper-cased since sightings are free text.
  const enemyIntelSystems = new Set(
    enemyDenIntel.map((r) => r.system?.trim().toUpperCase()).filter((s): s is string => !!s)
  )

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
        <a href="/structure" className={styles.backLink}>
          &laquo; Structures
        </a>
        <h1>Mercenary Dens</h1>
        <ShareAlliance alliances={alliances} sharedAllianceIds={sharedAllianceIds} />
      </div>

      <Topology nodeColors={nodeColors} enemyIntel={enemyIntelSystems} />

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
              const color = colorOf(row)
              const den = row.den
              const owner = den ? den.ownerLabel : (row.intel?.owner ?? null)
              return (
                <tr key={`${row.system}-${row.planet}-${i}`} className={color ? styles[`row_${color}`] : undefined}>
                  <td className={styles.system}>{row.system}</td>
                  <td className={styles.planet}>{row.planet || dash}</td>
                  <td>
                    {owner ?? dash}
                    {den?.ownerCharacterId ? <span className={styles.alliance}> ({den.ownerCharacterId})</span> : null}
                    {row.intel?.alliance ? <span className={styles.alliance}> [{row.intel.alliance}]</span> : null}
                  </td>
                  <td>{den?.state ?? dash}</td>
                  <td>{den ? evolution(den.development_level, den.development_amount) : dash}</td>
                  <td>{den ? evolution(den.anarchy_level, den.anarchy_amount) : dash}</td>
                  <td>{den?.infomorphs ?? dash}</td>
                  <td>
                    {isReinforced(row) ? (
                      <>
                        <span className={styles.reinforced}>
                          reinforced
                          {den?.reinforcement_end ? (
                            <>
                              {' '}
                              <Countdown end={den.reinforcement_end} now={now} />
                            </>
                          ) : null}
                        </span>
                        {den?.reinforcement_end ? (
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
                    ) : den || row.intel ? (
                      <span className={styles.stable}>stable</span>
                    ) : (
                      dash
                    )}
                  </td>
                  <td>
                    {den?.status_observed_at ? (
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
