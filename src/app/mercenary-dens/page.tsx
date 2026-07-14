import { redirect } from 'next/navigation'

import { mercenaryDensFlag } from '@/flags'
import { getSdePlanet } from '@/sdePlanets'
import { getSdeTypeNames } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { fetchOwners } from '../owners'
import CopyDiscordPing from './copyDiscordPing'
import { STAGING, TEMPERATE_PLANETS } from './data'
import { formatDuration, formatUtc } from './duration'
import ShareCorps from './shareCorps'
import { Topology, type NodeColor } from './topology'
import styles from './mercenaryDens.module.css'

export const dynamic = 'force-dynamic'

// A den we can see in the DB — our own, plus dens shared to one of our corps
// (RLS on character_mercenary_den only ever surfaces those). So every DB den is
// "ours" for colouring purposes; external dens come only from the hand-kept intel.
type DenRow = {
  character_id: string
  den_id: number
  planet_id: number
  type_id: number | null
  state: string | null
  development_level: string | null
  development_amount: number | null
  anarchy_level: string | null
  anarchy_amount: number | null
  infomorphs: number | null
  reinforcement_end: string | null
  skyhook_id: number | null
  skyhook_corporation_id: number | null
  status_observed_at: string | null
}

type MergedRow = {
  system: string
  planet: string // roman numeral
  intel?: { owner: string; alliance: string | null; reinforced: boolean }
  den?: DenRow & { ownerLabel: string; ownerCharacterId: string | null; typeName: string | null }
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

  if (!(await mercenaryDensFlag())) {
    redirect('/')
  }

  // The caller's characters + corporations (share targets, and to label/scope own
  // dens) and which corps their dens are currently shared with.
  const { corporations } = await fetchOwners(supabase)
  const { data: myRegs } = await supabase.from('registration').select('id, name, character_id')
  const ownRegById = new Map(
    (myRegs ?? []).map((r) => [
      r.id as string,
      { name: r.name as string, characterId: r.character_id != null ? String(r.character_id) : null },
    ])
  )
  const registrationIds = [...ownRegById.keys()]
  const { data: shares } = registrationIds.length
    ? await supabase.from('character_mercenary_den_share').select('corporation_id').in('character_id', registrationIds)
    : { data: [] }
  const sharedCorpIds = [...new Set((shares ?? []).map((s) => String(s.corporation_id)))]

  // Every mercenary den we can see (own + shared to our corps), each enriched
  // with its latest observed status (the view left-joins it).
  const { data: denData } = await supabase.from('character_mercenary_den').select('*')
  const dens = (denData ?? []) as DenRow[]
  const typeNames = getSdeTypeNames(dens.map((d) => d.type_id).filter((t): t is number => t != null))

  // Merge the hand-maintained temperate-planet intel with our real dens, keyed by
  // system + roman numeral. A den's planet_id is resolved to (system, roman) via
  // the generated SDE (src/sdePlanets.ts); dens on a planet not in the static
  // list are appended as extra rows.
  const rowsByKey = new Map<string, MergedRow>()
  const key = (system: string, planet: string) => `${system}|${planet}`

  for (const { system, planet, den } of TEMPERATE_PLANETS) {
    rowsByKey.set(key(system, planet), { system, planet, intel: den ?? undefined })
  }

  for (const den of dens) {
    const planet = getSdePlanet(den.planet_id)
    const system = planet?.systemName ?? ''
    const roman = planet?.roman ?? ''
    const ownReg = ownRegById.get(den.character_id)
    const enriched = {
      ...den,
      ownerLabel: ownReg?.name ?? 'Corpmate',
      // The EVE character id, shown in parens after the owner. Only resolvable
      // for the caller's own characters — a corpmate's registration is hidden
      // by RLS, so their id (and name) stay unknown.
      ownerCharacterId: ownReg?.characterId ?? null,
      typeName: den.type_id != null ? (typeNames[den.type_id] ?? null) : null,
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
  const rows = [...staticRows, ...extraRows]

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

  const dash = <span className={styles.empty}>—</span>
  const evolution = (level: string | null, amount: number | null) =>
    level != null ? `${level}${amount != null ? ` (${amount})` : ''}` : dash

  // One render-time reference point for the countdown/elapsed cells, so every
  // row is measured against the same instant.
  const now = Date.now()

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Mercenary Dens</h1>
        <ShareCorps corporations={corporations} sharedCorpIds={sharedCorpIds} />
      </div>
      <p className={styles.subtitle}>
        Systems immediately accessible from our staging system, <span className={styles.system}>{STAGING}</span>.
      </p>

      <Topology nodeColors={nodeColors} />

      <h2>Temperate planets</h2>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>System</th>
              <th>Planet</th>
              <th>Den ID</th>
              <th>Owner</th>
              <th>Type</th>
              <th>State</th>
              <th>Development</th>
              <th>Anarchy</th>
              <th>Infomorphs</th>
              <th>Reinforced</th>
              <th>Skyhook</th>
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
                  <td className={styles.planet}>{den ? den.den_id : dash}</td>
                  <td>
                    {owner ?? dash}
                    {den?.ownerCharacterId ? <span className={styles.alliance}> ({den.ownerCharacterId})</span> : null}
                    {row.intel?.alliance ? <span className={styles.alliance}> [{row.intel.alliance}]</span> : null}
                  </td>
                  <td>{den?.typeName ?? dash}</td>
                  <td>{den?.state ?? dash}</td>
                  <td>{den ? evolution(den.development_level, den.development_amount) : dash}</td>
                  <td>{den ? evolution(den.anarchy_level, den.anarchy_amount) : dash}</td>
                  <td>{den?.infomorphs ?? dash}</td>
                  <td>
                    {isReinforced(row) ? (
                      <>
                        <span className={styles.reinforced}>
                          reinforced
                          {den?.reinforcement_end
                            ? ` ${formatDuration(new Date(den.reinforcement_end).getTime() - now)}`
                            : ''}
                        </span>
                        {den?.reinforcement_end ? (
                          <>
                            <span className={styles.timestamp}> {formatUtc(den.reinforcement_end)}</span>
                            <CopyDiscordPing
                              system={row.system}
                              planet={row.planet}
                              reinforcementEnd={den.reinforcement_end}
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
                  <td>{den?.skyhook_corporation_id ? `corp ${den.skyhook_corporation_id}` : dash}</td>
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
    </>
  )
}
export default MercenaryDensPage
