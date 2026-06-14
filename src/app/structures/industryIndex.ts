import type { createClient } from '@/utils/supabase/server'

// Per-structure industry cost indices. EVE's /industry/systems/ endpoint reports
// a cost index per solar system for each industry activity; the structures job
// snapshots them into industry_system_index. Here we decide which of those
// indices are *relevant* to a given structure based on the service modules it has
// fitted (corp_structure.services), and read back the latest snapshot per system.

type Supabase = Awaited<ReturnType<typeof createClient>>

// Activity strings exactly as ESI returns them in cost_indices[].activity (and as
// stored in industry_system_index.activity).
export type Activity =
  | 'manufacturing'
  | 'researching_time_efficiency'
  | 'researching_material_efficiency'
  | 'copying'
  | 'invention'
  | 'reaction'

// Human-readable labels for each activity.
export const INDEX_ACTIVITY_LABELS: Record<Activity, string> = {
  manufacturing: 'Manufacturing',
  reaction: 'Reaction',
  researching_material_efficiency: 'Research ME',
  researching_time_efficiency: 'Research TE',
  copying: 'Copying',
  invention: 'Invention',
}

// The order indices are rendered in, regardless of which modules surfaced them.
const ACTIVITY_ORDER: Activity[] = [
  'manufacturing',
  'reaction',
  'researching_material_efficiency',
  'researching_time_efficiency',
  'copying',
  'invention',
]

// Keyword → activities rules, tried in order; the first whose keyword appears in
// the service-module name wins. Matched case-insensitively on substrings so it
// holds whether ESI returns the full module name ("Standup Manufacturing Plant
// I") or a shortened service label, and across module tiers (Hyasyoda Research
// Lab, capital/supercapital shipyards).
const SERVICE_RULES: Array<{ match: string[]; activities: Activity[] }> = [
  { match: ['reactor', 'reaction'], activities: ['reaction'] },
  { match: ['invention'], activities: ['invention'] },
  { match: ['research'], activities: ['researching_material_efficiency', 'researching_time_efficiency', 'copying'] },
  { match: ['manufactur', 'shipyard'], activities: ['manufacturing'] },
]

// Which cost-index activities a single service module enables.
const serviceActivities = (serviceName: string): Activity[] => {
  const n = serviceName.toLowerCase()
  return SERVICE_RULES.find((r) => r.match.some((k) => n.includes(k)))?.activities ?? []
}

// The distinct industry activities relevant to a structure, given its fitted
// service modules, in display order. Offline modules count too — we surface what
// the structure is set up to do, not only what is powered on right now.
export const structureIndexActivities = (
  services: Array<{ name: string; state: string }> | null | undefined
): Activity[] => {
  const set = new Set<Activity>()
  for (const svc of services ?? []) {
    if (!svc?.name) continue
    for (const activity of serviceActivities(svc.name)) set.add(activity)
  }
  return ACTIVITY_ORDER.filter((a) => set.has(a))
}

// Cost indices are fractions (0.0432 → 4.32%); EVE shows them as a percentage.
export const formatIndex = (cost: number): string => `${(cost * 100).toFixed(2)}%`

type IndexRow = {
  system_id: number | string
  activity: string
  cost_index: number | string | null
}

// Latest cost index per system per activity, keyed system_id → activity → index.
// The pull job stamps every row in a run with one recorded_at and snapshots every
// system holding a structure, so the most recent recorded_at identifies the latest
// complete snapshot — fetch just those rows.
export const fetchLatestSystemIndexes = async (
  supabase: Supabase,
  systemIds: Iterable<number>
): Promise<Map<number, Map<Activity, number>>> => {
  const result = new Map<number, Map<Activity, number>>()
  const ids = [...new Set([...systemIds].filter((n) => Number.isFinite(n)))]
  if (ids.length === 0) return result

  const { data: latest } = await supabase
    .from('industry_system_index')
    .select('recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!latest?.recorded_at) return result

  const { data: rows } = await supabase
    .from('industry_system_index')
    .select('system_id, activity, cost_index')
    .eq('recorded_at', latest.recorded_at)
    .in('system_id', ids)

  for (const r of (rows ?? []) as IndexRow[]) {
    const cost = r.cost_index == null ? null : Number(r.cost_index)
    if (cost == null || !Number.isFinite(cost)) continue
    const system = Number(r.system_id)
    let byActivity = result.get(system)
    if (!byActivity) {
      byActivity = new Map()
      result.set(system, byActivity)
    }
    byActivity.set(r.activity as Activity, cost)
  }
  return result
}

type HistoryRow = IndexRow & { recorded_at: string }

export type IndexSeries = {
  values: number[]
  // recorded_at of the most recent point in `values`, ISO 8601.
  updatedAt: string
}

// 30-day cost-index history per system per activity, in chronological order.
// Used to draw sparklines next to each index. We pull the raw snapshots and
// keep them in `recorded_at` order; a daily bucket would smooth them more but
// the structures job runs a handful of times a day so the raw points already
// make a reasonable shape. Returning `updatedAt` alongside the values lets the
// sparkline surface "last updated" in a tooltip without a second lookup.
export const fetchSystemIndexHistory = async (
  supabase: Supabase,
  systemIds: Iterable<number>
): Promise<Map<number, Map<Activity, IndexSeries>>> => {
  const result = new Map<number, Map<Activity, IndexSeries>>()
  const ids = [...new Set([...systemIds].filter((n) => Number.isFinite(n)))]
  if (ids.length === 0) return result

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await supabase
    .from('industry_system_index')
    .select('system_id, activity, cost_index, recorded_at')
    .gte('recorded_at', since)
    .in('system_id', ids)
    .order('recorded_at', { ascending: true })

  for (const r of (rows ?? []) as HistoryRow[]) {
    const cost = r.cost_index == null ? null : Number(r.cost_index)
    if (cost == null || !Number.isFinite(cost)) continue
    const system = Number(r.system_id)
    let byActivity = result.get(system)
    if (!byActivity) {
      byActivity = new Map()
      result.set(system, byActivity)
    }
    const activity = r.activity as Activity
    let series = byActivity.get(activity)
    if (!series) {
      series = { values: [], updatedAt: r.recorded_at }
      byActivity.set(activity, series)
    }
    series.values.push(cost)
    // Rows arrive in ascending recorded_at, so the last write wins as the latest.
    series.updatedAt = r.recorded_at
  }
  return result
}
