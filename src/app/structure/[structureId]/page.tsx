import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { DateTime } from '../../DateTime'
import { ACTIVITY_NAMES } from '../../industry/jobFields'
import { formatIskValue } from '../../isk'
import { CharacterName, Name, SystemName } from '../../names'
import { fetchSystemNames } from '../../systemNames'
import { fetchTypeNames } from '../../typeNames'
import {
  fetchLatestSystemIndexes,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  structureIndexActivities,
} from '../industryIndex'
import { WindowSelect } from '../windowSelect'
import { structureWindowDays } from '../windows'
import retro from '../../retro.module.css'
import structureStyles from '../structures.module.css'

type Structure = {
  structure_id: number
  corporation_id: number
  type_id: number
  system_id: number
  profile_id: number | null
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  reinforce_hour: number | null
  next_reinforce_hour: number | null
  next_reinforce_apply: string | null
  next_reinforce_weekday: number | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
  updated_at: string | null
}

type Job = {
  job_id: number | string
  registration_id: string
  activity_id: number
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number
  status: string
  start_date: string
  end_date: string
  station_id: number | string | null
  facility_id: number | string | null
}

type Rig = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
}

// One row per (payer, UTC day) from structure_tax_revenue().
type TaxRow = {
  payer_id: number | string | null
  day: string
  jobs: number | string
  isk: number | string | null
}

type StructureParams = {
  params: Promise<{
    structureId: string
  }>
  searchParams: Promise<{ days?: string }>
}

const show = (value: string | number | null | undefined) => (value === null || value === undefined ? '—' : value)

const StructurePage = async ({ params, searchParams }: StructureParams) => {
  const { structureId } = await params
  const { days: daysParam } = await searchParams
  const windowDays = structureWindowDays(daysParam)
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // structure ids are bigints; only digits are valid, and validating guards the .or() filter below.
  const validId = /^\d+$/.test(structureId)

  const { data: structure } = validId
    ? await supabase
        .from('corp_structure')
        .select(
          'structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, reinforce_hour, next_reinforce_hour, next_reinforce_apply, next_reinforce_weekday, services, last_seen_at, updated_at'
        )
        .eq('structure_id', structureId)
        .maybeSingle()
    : { data: null }

  if (!structure) {
    return (
      <>
        <h1>Structure not found</h1>
        <p>
          No structure {structureId} is visible. It may not exist, or you may need to re-link a director character on
          the <Link href="/character">Characters</Link> page. Back to <Link href="/structure">Structures</Link>.
        </p>
      </>
    )
  }

  const s = structure as Structure

  // Fuel timer and reinforcement profile live in corp_structure_status now
  // (own-corp only). RLS returns a row only if the caller's corp owns this
  // structure — an alliance-mate viewing it via corp_structure sees neither.
  const { data: statusRow } = await supabase
    .from('corp_structure_status')
    .select('fuel_expires, profile_id')
    .eq('structure_id', structureId)
    .maybeSingle<{ fuel_expires: string | null; profile_id: number | null }>()
  s.fuel_expires = statusRow?.fuel_expires ?? null
  s.profile_id = statusRow?.profile_id ?? null

  const { data: jobsData } = await supabase
    .from('character_industry_job')
    .select(
      'job_id, registration_id, activity_id, blueprint_type_id, product_type_id, runs, status, start_date, end_date, station_id, facility_id'
    )
    .or(`station_id.eq.${structureId},facility_id.eq.${structureId}`)
    .eq('status', 'active')
    .order('end_date', { ascending: true })

  const jobs = (jobsData ?? []) as Job[]

  const { data: characters } = await supabase.from('registration').select('id, name')
  const characterName: Record<string, string> = Object.fromEntries((characters ?? []).map((c) => [c.id, c.name]))

  // Rigs fitted to this structure (pulled from corp assets by the corp-assets job).
  const { data: rigData } = await supabase
    .from('corp_structure_rig')
    .select('structure_id, location_flag, type_id')
    .eq('structure_id', structureId)
    .order('location_flag', { ascending: true })

  const rigs = (rigData ?? []) as Rig[]

  // Tax this structure earned over the selected window, grouped by payer and
  // UTC day. The join to each job's structure happens inside the function —
  // including, via industry_job_tax_facility(), for jobs installed by players
  // whose own rows this caller can't read (see the migration comment).
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const { data: taxData } = await supabase.rpc('structure_tax_revenue', {
    structure_id: structureId,
    since,
  })
  const taxRows = (taxData ?? []) as TaxRow[]

  // Payer names and the corp they fly for, same sources as /structure/revenue:
  // universe_name (the universe-names job) and character_affiliation (the
  // character-directory job).
  const payerIds = [...new Set(taxRows.map((r) => r.payer_id).filter((p) => p != null))].map(Number)
  const payerNames = new Map<string, string>()
  const payerCorps = new Map<string, string>()
  if (payerIds.length > 0) {
    const [{ data: charNames }, { data: affiliations }] = await Promise.all([
      supabase.from('universe_name').select('id, name').in('id', payerIds),
      supabase.from('character_affiliation').select('character_id, corporation_id').in('character_id', payerIds),
    ])
    for (const r of (charNames ?? []) as Array<{ id: number | string; name: string }>) {
      payerNames.set(String(r.id), r.name)
    }
    const corpByPayer = new Map<string, string>()
    const corpIds = new Set<number>()
    for (const a of (affiliations ?? []) as Array<{ character_id: number | string; corporation_id: number | string }>) {
      corpByPayer.set(String(a.character_id), String(a.corporation_id))
      corpIds.add(Number(a.corporation_id))
    }
    if (corpIds.size > 0) {
      const { data: corpNames } = await supabase
        .from('universe_name')
        .select('id, name')
        .in('id', [...corpIds])
      const corpNameById = new Map<string, string>()
      for (const r of (corpNames ?? []) as Array<{ id: number | string; name: string }>) {
        corpNameById.set(String(r.id), r.name)
      }
      for (const [payer, corpId] of corpByPayer) {
        const name = corpNameById.get(corpId)
        if (name) payerCorps.set(payer, name)
      }
    }
  }

  const taxTotalIsk = taxRows.reduce((sum, r) => sum + Number(r.isk ?? 0), 0)
  const taxTotalJobs = taxRows.reduce((sum, r) => sum + Number(r.jobs ?? 0), 0)

  // The payer leaderboard above the table: the same rows folded from
  // (payer, day) down to (payer), ranked by ISK. No extra query — the window's
  // rows are already in hand, and re-aggregating here keeps the two views
  // guaranteed consistent with each other.
  const byPayer = new Map<string, { payerId: string; isk: number; jobs: number }>()
  for (const r of taxRows) {
    const payerId = r.payer_id != null ? String(r.payer_id) : 'unknown'
    const entry = byPayer.get(payerId) ?? { payerId, isk: 0, jobs: 0 }
    entry.isk += Number(r.isk ?? 0)
    entry.jobs += Number(r.jobs ?? 0)
    byPayer.set(payerId, entry)
  }
  const leaderboard = [...byPayer.values()].sort((a, b) => b.isk - a.isk)

  const typeNames = await fetchTypeNames([
    Number(s.type_id),
    ...rigs.map((r) => Number(r.type_id)),
    ...jobs.flatMap((j) => {
      const ids = [Number(j.blueprint_type_id)]
      if (j.product_type_id != null) ids.push(Number(j.product_type_id))
      return ids
    }),
  ])

  const systemNames = await fetchSystemNames([Number(s.system_id)])

  const typeName = typeNames[Number(s.type_id)]
  const systemName = systemNames[Number(s.system_id)]

  // Industry cost indices relevant to this structure (those its fitted service
  // modules enable), pulled from the latest snapshot for its system.
  const indexActivities = structureIndexActivities(s.services)
  const indexesBySystem = await fetchLatestSystemIndexes(supabase, [Number(s.system_id)])
  const systemIndexes = indexesBySystem.get(Number(s.system_id))

  return (
    <>
      <h1 className="serif">{s.name ?? `Structure #${s.structure_id}`}</h1>
      <p>
        <Link href="/structure">&laquo; Back to Structures</Link>
      </p>

      <table className={retro.retro}>
        <tbody>
          <tr>
            <th>Structure ID</th>
            <td>{s.structure_id}</td>
          </tr>
          <tr>
            <th>Type</th>
            <td>
              <Name name={typeName} id={s.type_id} />
            </td>
          </tr>
          <tr>
            <th>System</th>
            <td>
              <SystemName name={systemName} id={s.system_id} />
            </td>
          </tr>
          <tr>
            <th>Profile ID</th>
            <td>{show(s.profile_id)}</td>
          </tr>
          <tr>
            <th>State</th>
            <td>{show(s.state)}</td>
          </tr>
          <tr>
            <th>Fuel Expires</th>
            <td>
              <DateTime value={s.fuel_expires} />
            </td>
          </tr>
          <tr>
            <th>Unanchors At</th>
            <td>
              <DateTime value={s.unanchors_at} />
            </td>
          </tr>
          <tr>
            <th>Reinforce Hour</th>
            <td>{show(s.reinforce_hour)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Hour</th>
            <td>{show(s.next_reinforce_hour)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Weekday</th>
            <td>{show(s.next_reinforce_weekday)}</td>
          </tr>
          <tr>
            <th>Next Reinforce Apply</th>
            <td>
              <DateTime value={s.next_reinforce_apply} />
            </td>
          </tr>
          <tr>
            <th>Services</th>
            <td>{s.services?.map((svc) => `${svc.name} (${svc.state})`).join(', ') ?? '—'}</td>
          </tr>
          <tr>
            <th>Rigs</th>
            <td>
              {rigs.length > 0 ? rigs.map((r) => typeNames[Number(r.type_id)] ?? `#${r.type_id}`).join(', ') : '—'}
            </td>
          </tr>
          <tr>
            <th>Industry Indexes</th>
            <td>
              {indexActivities.length > 0
                ? indexActivities
                    .map((activity) => {
                      const cost = systemIndexes?.get(activity)
                      return `${INDEX_ACTIVITY_LABELS[activity]} ${cost != null ? formatIndex(cost) : '—'}`
                    })
                    .join(', ')
                : '—'}
            </td>
          </tr>
          <tr>
            <th>Last Seen</th>
            <td>
              <DateTime value={s.last_seen_at} />
            </td>
          </tr>
          <tr>
            <th>Updated At</th>
            <td>
              <DateTime value={s.updated_at} />
            </td>
          </tr>
        </tbody>
      </table>

      <div className={structureStyles.header}>
        <h2>Tax Revenue</h2>
        <span className={structureStyles.headerControl}>
          <span className={structureStyles.headerControlLabel}>Window</span>
          <WindowSelect days={windowDays} path={`/structure/${s.structure_id}`} />
        </span>
      </div>
      {leaderboard.length > 0 && (
        <ol className={structureStyles.payerGrid}>
          {leaderboard.map((p, i) => {
            const known = p.payerId !== 'unknown'
            return (
              <li key={`payer-${p.payerId}`} className={structureStyles.payerCard}>
                <span className={structureStyles.payerRank}>#{i + 1}</span>
                {/* Plain <img>, like the app's other CCP image-server uses, which
                    keeps images.evetech.net out of next.config.mjs's remote patterns. */}
                {known ? (
                  <img
                    className={structureStyles.payerAvatar}
                    src={`https://images.evetech.net/characters/${p.payerId}/portrait?size=64`}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                  />
                ) : (
                  <span className={structureStyles.payerAvatar} />
                )}
                <span className={structureStyles.payerCardName}>
                  <Name name={known ? payerNames.get(p.payerId) : undefined} id={known ? p.payerId : undefined} />
                </span>
                <span className={`${structureStyles.payerTotal} ${retro.num}`}>{formatIskValue(p.isk)}</span>
              </li>
            )
          })}
        </ol>
      )}

      {taxRows.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Payer</th>
              <th>Day</th>
              <th className={retro.num}>Jobs</th>
              <th className={retro.num}>ISK</th>
            </tr>
          </thead>
          <tbody>
            {taxRows.map((r) => {
              const payer = r.payer_id != null ? String(r.payer_id) : undefined
              return (
                <tr key={`tax-${payer ?? 'unknown'}-${r.day}`}>
                  <td>
                    <span className={structureStyles.payer}>
                      <Name name={payer ? payerNames.get(payer) : undefined} id={r.payer_id} />
                      {payer && payerCorps.get(payer) && (
                        <span className={structureStyles.payerCorp}>{payerCorps.get(payer)}</span>
                      )}
                    </span>
                  </td>
                  <td className="serif">{r.day}</td>
                  <td className={retro.num}>{Number(r.jobs)}</td>
                  <td className={retro.num}>{formatIskValue(r.isk)}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th />
              <th className={retro.num}>{taxTotalJobs}</th>
              <th className={retro.num}>{formatIskValue(taxTotalIsk)}</th>
            </tr>
          </tfoot>
        </table>
      ) : (
        <p>No industry tax from this structure in the last {windowDays} days.</p>
      )}

      <h2>Industry Jobs</h2>
      {jobs.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Character</th>
              <th>Activity</th>
              <th>Blueprint</th>
              <th>Product</th>
              <th className={retro.num}>Runs</th>
              <th>Status</th>
              <th>Start</th>
              <th>End</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={`job-${j.job_id}`}>
                <td>
                  <CharacterName name={characterName[j.registration_id]} />
                </td>
                <td className="serif">{ACTIVITY_NAMES[j.activity_id] ?? `#${j.activity_id}`}</td>
                <td>
                  <Name name={typeNames[Number(j.blueprint_type_id)]} id={j.blueprint_type_id} />
                </td>
                <td>
                  {j.product_type_id != null ? (
                    <Name name={typeNames[Number(j.product_type_id)]} id={j.product_type_id} />
                  ) : (
                    '—'
                  )}
                </td>
                <td className={retro.num}>{j.runs}</td>
                <td>{j.status}</td>
                <td>
                  <DateTime value={j.start_date} />
                </td>
                <td>
                  <DateTime value={j.end_date} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No industry jobs known at this structure.</p>
      )}
    </>
  )
}

export default StructurePage
