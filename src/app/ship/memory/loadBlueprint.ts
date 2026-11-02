// The loader behind a blueprint's dossier (blueprintDossier.ts): the
// blueprint's versions from both blueprint history tables and every industry
// job that names it as blueprint_id from both job tables, on whatever
// Supabase client the caller hands in. The MCP tool passes the caller's
// bearer client, so this is the reader's own data under RLS, narrowed to the
// owners it is given besides: the tenant policy on the job tables shows a
// co-tenant's jobs too, and seeing a job is not owning the blueprint it ran.
import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchAllRows } from '../../api/mcp/lib'
import type { BlueprintJob, BlueprintVersion } from './blueprintDossier'
import type { Owner, OwnerKind } from './dossier'

export type Owners = { registrationIds: string[]; corporationIds: string[] }

type Side = {
  kind: OwnerKind
  blueprintTable: 'character_blueprint_over_time' | 'corp_blueprint_over_time'
  jobTable: 'character_industry_job_over_time' | 'corp_industry_job_over_time'
  ownerColumn: 'registration_id' | 'corporation_id'
  ids: string[]
  job: 'character-blueprints' | 'corp-blueprints'
}

const sides = (owners: Owners): Side[] => [
  {
    kind: 'character',
    blueprintTable: 'character_blueprint_over_time',
    jobTable: 'character_industry_job_over_time',
    ownerColumn: 'registration_id',
    ids: owners.registrationIds,
    job: 'character-blueprints',
  },
  {
    kind: 'corporation',
    blueprintTable: 'corp_blueprint_over_time',
    jobTable: 'corp_industry_job_over_time',
    ownerColumn: 'corporation_id',
    ids: owners.corporationIds,
    job: 'corp-blueprints',
  },
]

type VersionRow = {
  registration_id?: string
  corporation_id?: number | string
  type_id: number | string
  quantity: number | string | null
  material_efficiency: number | null
  time_efficiency: number | null
  runs: number | null
  location_id: number | string | null
  location_flag: string | null
  is_current: boolean
  valid_from: string
  valid_until: string
}

type JobRow = {
  job_id: number | string
  registration_id?: string
  corporation_id?: number | string
  installer_id: number | string
  activity_id: number
  runs: number
  licensed_runs: number | null
  successful_runs: number | null
  product_type_id: number | string | null
  facility_id: number | string
  cost: number | string | null
  status: string
  start_date: string
  end_date: string
  valid_from: string
}

const ownerOf = (side: Side, row: { registration_id?: string; corporation_id?: number | string }): Owner => ({
  kind: side.kind,
  id: String(side.kind === 'character' ? row.registration_id : row.corporation_id),
})

const versionsOf = async (supabase: SupabaseClient, side: Side, itemId: number): Promise<BlueprintVersion[]> => {
  if (side.ids.length === 0) return []
  const rows = await fetchAllRows<VersionRow>((from, to) =>
    supabase
      .from(side.blueprintTable)
      .select(
        `${side.ownerColumn}, type_id, quantity, material_efficiency, time_efficiency, runs, location_id, location_flag, is_current, valid_from, valid_until`
      )
      .eq('item_id', itemId)
      .in(side.ownerColumn, side.ids)
      .order('valid_from')
      .range(from, to)
      .returns<VersionRow[]>()
  )
  return rows.map((r) => ({
    owner: ownerOf(side, r),
    typeId: Number(r.type_id),
    quantity: r.quantity == null ? null : Number(r.quantity),
    me: r.material_efficiency,
    te: r.time_efficiency,
    runs: r.runs,
    locationId: r.location_id == null ? null : Number(r.location_id),
    locationFlag: r.location_flag,
    isCurrent: r.is_current,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }))
}

// Every job that ran with the blueprint, one row per job (its newest
// version: a job's facts do not change, only its status).
const jobsOf = async (supabase: SupabaseClient, side: Side, itemId: number): Promise<BlueprintJob[]> => {
  if (side.ids.length === 0) return []
  const rows = await fetchAllRows<JobRow>((from, to) =>
    supabase
      .from(side.jobTable)
      .select(
        `job_id, ${side.ownerColumn}, installer_id, activity_id, runs, licensed_runs, successful_runs, product_type_id, facility_id, cost, status, start_date, end_date, valid_from`
      )
      .eq('blueprint_id', itemId)
      .in(side.ownerColumn, side.ids)
      .order('valid_from')
      .range(from, to)
      .returns<JobRow[]>()
  )
  const newest = new Map<string, JobRow>()
  rows.forEach((r) => newest.set(String(r.job_id), r))
  return [...newest.values()].map((r) => ({
    jobId: Number(r.job_id),
    owner: ownerOf(side, r),
    installerId: Number(r.installer_id),
    activityId: Number(r.activity_id),
    runs: Number(r.runs),
    licensedRuns: r.licensed_runs,
    successfulRuns: r.successful_runs,
    productTypeId: r.product_type_id == null ? null : Number(r.product_type_id),
    facilityId: Number(r.facility_id),
    cost: r.cost == null ? null : Number(r.cost),
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
  }))
}

// When the owner's blueprints were last listed successfully: an open row's
// own stamp is only its debut.
const lastRefreshOf = async (supabase: SupabaseClient, side: Side, ownerId: string): Promise<string | null> => {
  const { data } = await supabase
    .from('heartbeat')
    .select('ended_at')
    .eq('job', side.job)
    .eq(side.ownerColumn, ownerId)
    .eq('ok', true)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ ended_at: string }>()
  return data?.ended_at ?? null
}

export type BlueprintInput = { itemId: number; versions: BlueprintVersion[]; jobs: BlueprintJob[]; lastSeen: string }

// Null when no owner of the caller's has held the blueprint.
export const loadBlueprintInput = async (
  supabase: SupabaseClient,
  owners: Owners,
  itemId: number
): Promise<BlueprintInput | null> => {
  const [versionSets, jobSets] = await Promise.all([
    Promise.all(sides(owners).map((s) => versionsOf(supabase, s, itemId))),
    Promise.all(sides(owners).map((s) => jobsOf(supabase, s, itemId))),
  ])
  const versions = versionSets.flat().sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime())
  if (versions.length === 0) return null
  const newest = versions[versions.length - 1]
  const side = sides(owners).find((s) => s.kind === newest.owner.kind) as Side
  const lastRefresh = newest.isCurrent ? await lastRefreshOf(supabase, side, newest.owner.id) : null
  return {
    itemId,
    versions,
    jobs: jobSets.flat(),
    lastSeen: newest.isCurrent ? (lastRefresh ?? newest.validUntil) : newest.validUntil,
  }
}
