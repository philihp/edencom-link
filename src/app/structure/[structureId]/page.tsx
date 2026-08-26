import Link from 'next/link'
import { redirect } from 'next/navigation'
import { chain, descend, map, reduce, reject, sortWith, sum, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { fetchTaxRates, formatRate } from '../../settings/tax/rates'
import { costAvoidance } from '../costAvoidance'
import { DateTime } from '../../DateTime'
import { ACTIVITY_NAMES } from '../../industry/jobFields'
import { formatIskValue } from '../../isk'
import { formatRelativeFuture } from '../../relativeTime'
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

// Nullable where a director is what supplies the value: a structure reached
// through the public directory rather than corp_structure knows its name,
// system, type and owner, and nothing else.
type Structure = {
  structure_id: number
  corporation_id: number | null
  type_id: number | null
  system_id: number | null
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
  last_seen_at: string | null
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

// One row per (payer, UTC day) from structure_tax_revenue(), carrying the same
// measures /structure shows per tile. They OVERLAP and are never netted: `isk`
// is tax that arrived, `isk_paid` is tax our side paid whoever owns this
// structure, and a member billing their own corporation is both at once.
// `isk_self_paid` is the subset of what we paid that was billed at our own rate
// — the basis of the cost-avoidance figure rather than revenue — and `isk_total`
// counts every entry once, which is what the leaderboard can rank without
// double-counting the overlap. All come back positive.
type TaxRow = {
  payer_id: number | string | null
  day: string
  jobs: number | string
  isk: number | string | null
  self_paid_jobs: number | string
  isk_self_paid: number | string | null
  paid_jobs: number | string
  isk_paid: number | string | null
  total_jobs: number | string
  isk_total: number | string | null
}

// universe_name rows, and the id -> name map every one of them turns into.
type IdName = { id: number | string; name: string }

const nameById = (rows: readonly IdName[]): Map<string, string> =>
  new Map(map((r: IdName) => [String(r.id), r.name] as [string, string], rows))

type AffiliationRow = { character_id: number | string; corporation_id: number | string }

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

  const { data: scanned } = validId
    ? await supabase
        .from('corp_structure')
        .select(
          'structure_id, corporation_id, type_id, system_id, name, state, unanchors_at, reinforce_hour, next_reinforce_hour, next_reinforce_apply, next_reinforce_weekday, services, last_seen_at, updated_at'
        )
        .eq('structure_id', structureId)
        .maybeSingle()
    : { data: null }

  // /structure now lists structures our jobs run in but no director of ours can
  // scan (src/app/structure/roster.ts), so those tiles link here too. There is
  // no corp_structure row behind one — fall back to the public directory, which
  // carries what ESI tells a visitor: a name, a system, a type and an owner.
  // Everything below this that needs a director (fuel, rigs, reinforcement)
  // simply comes back empty and renders as "—"; the jobs we run there and the
  // tax we paid for them are ours to read either way.
  const { data: directory } =
    validId && !scanned
      ? await supabase
          .from('universe_structure')
          .select('structure_id, name, system_id, type_id, owner_corporation_id, resolved_at')
          .eq('structure_id', structureId)
          .maybeSingle<{
            structure_id: number | string
            name: string | null
            system_id: number | string | null
            type_id: number | string | null
            owner_corporation_id: number | string | null
            resolved_at: string | null
          }>()
      : { data: null }

  const structure =
    scanned ??
    (directory
      ? {
          structure_id: Number(directory.structure_id),
          corporation_id: directory.owner_corporation_id != null ? Number(directory.owner_corporation_id) : null,
          type_id: directory.type_id != null ? Number(directory.type_id) : null,
          system_id: directory.system_id != null ? Number(directory.system_id) : null,
          name: directory.name,
          state: null,
          unanchors_at: null,
          reinforce_hour: null,
          next_reinforce_hour: null,
          next_reinforce_apply: null,
          next_reinforce_weekday: null,
          services: null,
          last_seen_at: directory.resolved_at,
          updated_at: null,
        }
      : null)

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
  const payerIds = uniq(
    map(
      Number,
      reject(
        (id): id is null => id == null,
        map((r: TaxRow) => r.payer_id, taxRows)
      )
    )
  )

  const [{ data: charNames }, { data: affiliations }] = payerIds.length
    ? await Promise.all([
        supabase.from('universe_name').select('id, name').in('id', payerIds),
        supabase.from('character_affiliation').select('character_id, corporation_id').in('character_id', payerIds),
      ])
    : [{ data: [] }, { data: [] }]

  const payerNames = nameById((charNames ?? []) as IdName[])

  const affiliationRows = (affiliations ?? []) as AffiliationRow[]
  const corpByPayer = map(
    (a: AffiliationRow) => [String(a.character_id), String(a.corporation_id)] as [string, string],
    affiliationRows
  )
  const corpIds = uniq(map((a: AffiliationRow) => Number(a.corporation_id), affiliationRows))

  const { data: corpNames } = corpIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', corpIds)
    : { data: [] }
  const corpNameById = nameById((corpNames ?? []) as IdName[])

  // A payer whose corporation the directory hasn't named yet simply has no corp
  // line, rather than one reading as an id.
  const payerCorps = new Map<string, string>(
    chain(([payer, corpId]: [string, string]) => {
      const name = corpNameById.get(corpId)
      return name ? [[payer, name] as [string, string]] : []
    }, corpByPayer)
  )

  const totalOf = (pick: (r: TaxRow) => number | string | null) =>
    sum(map((r: TaxRow) => Number(pick(r) ?? 0), taxRows))
  const taxTotalIsk = totalOf((r) => r.isk)
  const taxTotalJobs = totalOf((r) => r.jobs)
  const selfPaidIsk = totalOf((r) => r.isk_self_paid)
  const paidIsk = totalOf((r) => r.isk_paid)
  const paidJobs = totalOf((r) => r.paid_jobs)
  const selfPaidJobs = totalOf((r) => r.self_paid_jobs)

  // The same arithmetic the list page's Cost Avoidance tile runs, over this
  // structure's own-rate charges alone — reusing costAvoidance() rather than
  // repeating the formula, so the two can't disagree about what a saving is.
  const taxRates = await fetchTaxRates(supabase, user.id)
  const avoidance = costAvoidance([{ structureId: String(s.structure_id), amount: selfPaidIsk }], taxRates)
  // What we paid that was NOT billed at our own rate: a landlord charges a
  // corporation it doesn't contain whatever it likes, so none of it is a saving.
  const paidAtOtherRate = paidIsk - selfPaidIsk
  // A structure whose corp installs everything under corp ownership has only
  // outgoing rows, so the received column would be all zeroes; the extra column
  // earns its width only when there is something in it.
  const showPaid = paidJobs > 0

  // The payer leaderboard above the table: the same rows folded from
  // (payer, day) down to (payer), ranked by ISK. No extra query — the window's
  // rows are already in hand, and re-aggregating here keeps the two views
  // guaranteed consistent with each other.
  // The leaderboard ranks who put the most industry through this structure,
  // which is the same question whichever wallet the tax came out of — so it
  // ranks on isk_total, every charge counted once. Adding revenue to taxes paid
  // would count a member's own-corp job twice, since that one charge is both.
  type PayerTotal = { payerId: string; isk: number; jobs: number }
  const byPayer = reduce(
    (acc: Map<string, PayerTotal>, r: TaxRow) => {
      const payerId = r.payer_id != null ? String(r.payer_id) : 'unknown'
      const entry = acc.get(payerId) ?? { payerId, isk: 0, jobs: 0 }
      entry.isk += Number(r.isk_total ?? 0)
      entry.jobs += Number(r.total_jobs ?? 0)
      return acc.set(payerId, entry)
    },
    new Map<string, PayerTotal>(),
    taxRows
  )
  const leaderboard = sortWith([descend((p: PayerTotal) => p.isk)], [...byPayer.values()])

  // `Number(null)` is 0, a finite id every resolver would go looking for, so a
  // structure the directory couldn't type contributes no id rather than a zero.
  const typeNames = await fetchTypeNames([
    ...(s.type_id != null ? [Number(s.type_id)] : []),
    ...rigs.map((r) => Number(r.type_id)),
    ...jobs.flatMap((j) => {
      const ids = [Number(j.blueprint_type_id)]
      if (j.product_type_id != null) ids.push(Number(j.product_type_id))
      return ids
    }),
  ])

  const systemNames = await fetchSystemNames(s.system_id != null ? [Number(s.system_id)] : [])

  const typeName = s.type_id != null ? typeNames[Number(s.type_id)] : undefined
  const systemName = s.system_id != null ? systemNames[Number(s.system_id)] : undefined

  // Industry cost indices relevant to this structure (those its fitted service
  // modules enable), pulled from the latest snapshot for its system.
  const indexActivities = structureIndexActivities(s.services)
  const indexesBySystem = await fetchLatestSystemIndexes(supabase, s.system_id != null ? [Number(s.system_id)] : [])
  const systemIndexes = s.system_id != null ? indexesBySystem.get(Number(s.system_id)) : undefined

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
              {s.fuel_expires &&
                (() => {
                  const relative = formatRelativeFuture(s.fuel_expires, new Date())
                  return relative ? <span className={structureStyles.subValue}> {relative}</span> : null
                })()}
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
              {showPaid && (
                <>
                  <th className={retro.num}>Paid Jobs</th>
                  <th className={retro.num}>Paid ISK</th>
                </>
              )}
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
                  {showPaid && (
                    <>
                      <td className={retro.num}>{Number(r.paid_jobs)}</td>
                      <td className={retro.num}>{formatIskValue(r.isk_paid)}</td>
                    </>
                  )}
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
              {showPaid && (
                <>
                  <th className={retro.num}>{paidJobs}</th>
                  <th className={retro.num}>{formatIskValue(paidIsk)}</th>
                </>
              )}
            </tr>
          </tfoot>
        </table>
      ) : (
        <p>No industry tax from this structure in the last {windowDays} days.</p>
      )}
      {showPaid && (
        <p className={structureStyles.unaccountedNote}>
          <em>
            ISK is tax that arrived here; Paid ISK is what we were charged to run our own jobs here, whoever owns the
            structure. One charge can be both — a member billing their own corporation pays it and we receive it — so
            the two columns describe the same events from different sides rather than summing to a balance.
          </em>
        </p>
      )}

      {selfPaidIsk > 0 && (
        <>
          <h2>Cost Avoidance</h2>
          <table className={retro.retro}>
            <tbody>
              <tr>
                <td>
                  <span className={structureStyles.payer}>
                    <span>
                      Billed at our own rate <span className={retro.muted}>({formatRate(taxRates.own)})</span>
                    </span>
                    <span className={structureStyles.payerCorp}>
                      {selfPaidJobs.toLocaleString()} charge{selfPaidJobs === 1 ? '' : 's'} on jobs of ours run in a
                      structure we own
                    </span>
                  </span>
                </td>
                <td className={retro.num}>{formatIskValue(selfPaidIsk)}</td>
              </tr>
              <tr>
                <td>
                  <span className={structureStyles.payer}>
                    <span>
                      The same jobs in a public structure{' '}
                      <span className={retro.muted}>({formatRate(taxRates.public)})</span>
                    </span>
                    <span className={structureStyles.payerCorp}>
                      what they would have been billed, and kept none of
                    </span>
                  </span>
                </td>
                <td className={retro.num}>
                  {avoidance.counterfactual == null ? '—' : formatIskValue(avoidance.counterfactual)}
                </td>
              </tr>
              <tr>
                <th>Avoided</th>
                <th className={retro.num}>{avoidance.total == null ? '—' : formatIskValue(avoidance.total)}</th>
              </tr>
            </tbody>
          </table>
          <p className={structureStyles.unaccountedNote}>
            <em>
              {avoidance.total == null ? (
                <>
                  Cost avoidance needs a non-zero rate for your own characters — nothing was billed, so there is no
                  receipt to price a public structure against.{' '}
                </>
              ) : (
                <>
                  The tax receipt is {formatRate(taxRates.own)} of the job&rsquo;s Estimated Item Value, so the same
                  jobs at {formatRate(taxRates.public)} come to {formatRate(taxRates.public)} ÷{' '}
                  {formatRate(taxRates.own)} times as much, and the difference is the expense never incurred. No ISK
                  changed hands, so it is not revenue.{' '}
                </>
              )}
              {paidAtOtherRate > 0 && (
                <>
                  A further {formatIskValue(paidAtOtherRate)} of tax we paid here is excluded — it was not billed at our
                  own rate, so there is no own rate to scale.{' '}
                </>
              )}
              <Link href="/settings/tax">Change the rates &raquo;</Link>
            </em>
          </p>
        </>
      )}

      {selfPaidIsk === 0 && paidIsk > 0 && (
        <p className={structureStyles.unaccountedNote}>
          <em>
            No cost avoidance here: none of the {formatIskValue(paidIsk)} we paid was billed at our own rate, because
            this structure isn&rsquo;t ours. A landlord bills us whatever rate it likes, so there is no saving to price.
          </em>
        </p>
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
