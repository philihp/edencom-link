import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
import { formatMisk } from '../isk'
import { fetchSystemNames } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import { StructureSilhouette } from './silhouette'
import styles from './structures.module.css'

type Structure = {
  structure_id: number
  corporation_id: number
  type_id: number
  system_id: number
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
}

type JobRow = {
  job_id: number | string
  station_id: number | string | null
  facility_id: number | string | null
}

type JournalRow = {
  amount: number | string | null
  context_id: number | string | null
  description: string | null
  first_party_id: number | string | null
}

type RigRow = {
  structure_id: number | string
  location_flag: string
  type_id: number | string
}

const StructuresPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  const { data: structures } = await supabase
    .schema('hangar')
    .from('corp_structure')
    .select(
      'structure_id, corporation_id, type_id, system_id, name, state, fuel_expires, unanchors_at, services, last_seen_at'
    )
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const list = (structures ?? []) as Structure[]

  // Tax revenue each structure generates. Each industry-tax journal entry references its job via
  // context_id (context_id_type = industry_job_id); outer-join those job ids to the industry_job
  // table to find the structure (station_id, falling back to facility_id) the job is installed in,
  // then sum the journal amounts. Bigint ids can come back from PostgREST as strings, so key every
  // map by string.
  const structureIds = list.map((s) => Number(s.structure_id))
  const { data: jobs } = structureIds.length
    ? await supabase
        .schema('hangar')
        .from('industry_job')
        .select('job_id, station_id, facility_id')
        .or(`station_id.in.(${structureIds.join(',')}),facility_id.in.(${structureIds.join(',')})`)
    : { data: [] }

  const structureByJob = new Map<string, string>()
  for (const j of (jobs ?? []) as JobRow[]) {
    const structureId = j.station_id ?? j.facility_id
    if (structureId != null) structureByJob.set(String(j.job_id), String(structureId))
  }

  // Rigs fitted to each structure (pulled from corp assets by the structures job).
  const { data: rigRows } = structureIds.length
    ? await supabase
        .schema('hangar')
        .from('corp_structure_rig')
        .select('structure_id, location_flag, type_id')
        .in('structure_id', structureIds)
        .order('location_flag', { ascending: true })
    : { data: [] }

  const rigList = (rigRows ?? []) as RigRow[]
  const rigTypeNames = await fetchTypeNames(rigList.map((r) => Number(r.type_id)))
  const rigsByStructure = new Map<string, string[]>()
  for (const r of rigList) {
    const key = String(r.structure_id)
    const name = rigTypeNames[Number(r.type_id)] ?? String(r.type_id)
    const existing = rigsByStructure.get(key)
    if (existing) existing.push(name)
    else rigsByStructure.set(key, [name])
  }

  const systemNames = await fetchSystemNames(list.map((s) => Number(s.system_id)))
  const structureTypeNames = await fetchTypeNames(list.map((s) => Number(s.type_id)))

  const { data: journal } = await supabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('amount, context_id, description, first_party_id')
    .eq('ref_type', 'industry_job_tax')

  const totalByStructure = new Map<string, number>()
  // Unaccounted tax broken down by the party that paid it (the character/corp that ran the job).
  const unaccountedByParty = new Map<string, number>()
  let unaccounted = 0
  for (const entry of (journal ?? []) as JournalRow[]) {
    const amount = Number(entry.amount ?? 0)
    // The job id is the entry's context_id; fall back to parsing it out of the description for older
    // entries (or any ref_type variants) where ESI didn't populate context_id.
    let structureId = entry.context_id != null ? structureByJob.get(String(entry.context_id)) : undefined
    if (!structureId) {
      for (const token of entry.description?.match(/\d+/g) ?? []) {
        structureId = structureByJob.get(token)
        if (structureId) break
      }
    }
    if (structureId) {
      totalByStructure.set(structureId, (totalByStructure.get(structureId) ?? 0) + amount)
    } else {
      // Tax we received but can't tie to one of our structures (e.g. jobs not in our table).
      unaccounted += amount
      const party = entry.first_party_id != null ? String(entry.first_party_id) : 'unknown'
      unaccountedByParty.set(party, (unaccountedByParty.get(party) ?? 0) + amount)
    }
  }

  // Largest payers first.
  const unaccountedParties = [...unaccountedByParty.entries()].sort((a, b) => b[1] - a[1])

  // Resolve each payer (a character) to their name and the corp they fly for. Names come from the
  // eve_name table and corp affiliations from character_corp, both populated by the daily job; ids
  // not yet resolved fall back to showing the raw id.
  const partyIds = unaccountedParties.map(([party]) => party).filter((p) => p !== 'unknown')
  const payerNames = new Map<string, string>()
  const payerCorps = new Map<string, string>()
  if (partyIds.length > 0) {
    const partyIdNums = partyIds.map(Number)
    const { data: charNames } = await supabase
      .schema('hangar')
      .from('eve_name')
      .select('id, name')
      .in('id', partyIdNums)
    for (const r of (charNames ?? []) as Array<{ id: number | string; name: string }>) {
      payerNames.set(String(r.id), r.name)
    }

    const { data: affiliations } = await supabase
      .schema('hangar')
      .from('character_corp')
      .select('character_id, corporation_id')
      .in('character_id', partyIdNums)
    const corpByParty = new Map<string, string>()
    const corpIds = new Set<number>()
    for (const a of (affiliations ?? []) as Array<{ character_id: number | string; corporation_id: number | string }>) {
      corpByParty.set(String(a.character_id), String(a.corporation_id))
      corpIds.add(Number(a.corporation_id))
    }
    if (corpIds.size > 0) {
      const { data: corpNames } = await supabase
        .schema('hangar')
        .from('eve_name')
        .select('id, name')
        .in('id', [...corpIds])
      const corpNameById = new Map<string, string>()
      for (const r of (corpNames ?? []) as Array<{ id: number | string; name: string }>) {
        corpNameById.set(String(r.id), r.name)
      }
      for (const [party, corpId] of corpByParty) {
        const name = corpNameById.get(corpId)
        if (name) payerCorps.set(party, name)
      }
    }
  }

  // Revenue from structure clone bays (jump clone installation and activation fees).
  const { data: cloneJournal } = await supabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('amount')
    .in('ref_type', ['jump_clone_installation_fee', 'jump_clone_activation_fee'])

  const cloneRevenue = ((cloneJournal ?? []) as Array<{ amount: number | string | null }>).reduce(
    (sum, entry) => sum + Number(entry.amount ?? 0),
    0
  )

  // When the Structures background job last finished. Each scheduled job writes a
  // row to hangar.heartbeat on completion; we read back the most recent one.
  const { data: lastRun } = await supabase
    .schema('hangar')
    .from('heartbeat')
    .select('ran_at')
    .eq('job', 'structures')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <>
      <h1>Structures</h1>
      {list.length > 0 ? (
        <>
          <ul className={styles.grid}>
            {list.map((s) => {
              const rigs = rigsByStructure.get(String(s.structure_id)) ?? []
              const services = s.services?.map((svc) => svc.name) ?? []
              return (
                <li key={`structure-${s.structure_id}`} className={styles.tile}>
                  <StructureSilhouette typeId={s.type_id} className={styles.silhouette} />
                  <div className={styles.head}>
                    <div>
                      <a href={`/structures/${s.structure_id}`} className={styles.name}>
                        {s.name ?? `Structure #${s.structure_id}`}
                      </a>
                      {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                      <span className={styles.subId}>#{s.structure_id}</span>
                    </div>
                  </div>

                  <div className={styles.fields}>
                    <span className={styles.label}>Revenue</span>
                    <span className={`${styles.value} ${styles.num}`}>
                      {formatMisk(totalByStructure.get(String(s.structure_id)) ?? 0)}
                    </span>
                    <span className={styles.label}>Type</span>
                    <span className={styles.value}>{structureTypeNames[Number(s.type_id)] ?? `#${s.type_id}`}</span>
                    <span className={styles.label}>System</span>
                    <span className={styles.value}>{systemNames[Number(s.system_id)] ?? s.system_id}</span>
                    <span className={styles.label}>Fuel Expires</span>
                    <span className={styles.value}>
                      <DateTime value={s.fuel_expires} />
                    </span>
                  </div>

                  <div className={styles.section}>
                    <span className={styles.sectionLabel}>Services</span>
                    {services.length > 0 ? (
                      <ul className={styles.chips}>
                        {services.map((svc, i) => (
                          <li key={`svc-${s.structure_id}-${i}`} className={styles.chip}>
                            {svc}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className={styles.empty}>—</span>
                    )}
                  </div>

                  <div className={styles.section}>
                    <span className={styles.sectionLabel}>Rigs</span>
                    {rigs.length > 0 ? (
                      <ul className={styles.chips}>
                        {rigs.map((rig, i) => (
                          <li key={`rig-${s.structure_id}-${i}`} className={styles.chip}>
                            {rig}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className={styles.empty}>—</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          <div className={styles.footer}>
            <span>Unaccounted tax revenue:</span>
            <span className={styles.footerValue}>{formatMisk(unaccounted)}</span>
            <span>Clone revenue:</span>
            <span className={styles.footerValue}>{formatMisk(cloneRevenue)}</span>
          </div>
          <p className={styles.unaccountedNote}>
            <em>
              Unaccounted revenue comes from industry jobs started by players we can&rsquo;t see, so we can&rsquo;t tie
              the tax back to one of our structures.
            </em>
          </p>
          {unaccountedParties.length > 0 && (
            <details className={styles.breakdown}>
              <summary>Breakdown by payer ({unaccountedParties.length})</summary>
              <div className={styles.breakdownGrid}>
                {unaccountedParties.map(([party, amount]) => {
                  const name = party === 'unknown' ? 'Unknown' : (payerNames.get(party) ?? party)
                  const corp = party === 'unknown' ? undefined : payerCorps.get(party)
                  return (
                    <span key={`party-${party}`} className={styles.breakdownRow}>
                      <span className={styles.payer}>
                        <span>{name}</span>
                        {corp && <span className={styles.payerCorp}>{corp}</span>}
                      </span>
                      <span className={styles.footerValue}>{formatMisk(amount)}</span>
                    </span>
                  )
                })}
              </div>
            </details>
          )}
        </>
      ) : (
        <p>
          No structures visible. Re-link a director character on the <a href="/character">Characters</a> page so the
          hourly job can fetch them.
        </p>
      )}
      <p className={styles.lastRun}>
        Structures last refreshed: <DateTime value={lastRun?.ran_at} fallback="never" />
      </p>
    </>
  )
}
export default StructuresPage
