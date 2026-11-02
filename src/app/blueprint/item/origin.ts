// Where a blueprint copy came from (docs/item-pages.md, "Where a copy came
// from"): the job of ours that most likely made it, matched on type and
// time at the copy's debut, the way ship memory infers a hull's origin. Pure,
// tested; the loader reads the rows and the page writes the answer as the
// item's first memory.
import { ACTIVITY } from './history.ts'

// How often the owner's blueprints are listed, so the match knows how far
// back before the debut the job could have delivered: the blueprint extracts
// run every 6h for a character, daily for a corporation (the same windows as
// ship memory's EXTRACT_INTERVAL_MS).
export const ORIGIN_WINDOW_MS = {
  character: 6 * 60 * 60 * 1000,
  corporation: 24 * 60 * 60 * 1000,
} as const

export type OriginJob = {
  job_id: number | string
  activity_id: number | string
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number | string
  licensed_runs?: number | string | null
  status: string
  end_date: string
  // When the output reached the hangar, where ESI reports it; a job sits
  // "ready" until the player delivers it.
  completed_date?: string | null
  station_id?: number | string | null
  facility_id?: number | string | null
}

export type OriginInput = {
  // The copy's type (a copy has its original's type id).
  typeId: number
  // The earliest version of the copy's item id in the owner's record.
  debut: string
  // The owner's earliest blueprint version of any item: a copy debuting then
  // was already in the hangar when the record began.
  recordStart: string | null
  ownerKind: keyof typeof ORIGIN_WINDOW_MS
  jobs: OriginJob[]
}

export type Origin =
  | { kind: 'predates' }
  | { kind: 'unknown' }
  | {
      kind: 'copied' | 'invented'
      jobId: string
      locationId: string | null
      deliveredAt: string
      copies: number
      licensedRuns: number | null
      confidence: 'high' | 'medium'
      // How many jobs matched the window; above one, this is the nearest.
      candidates: number
    }

const deliveredAt = (job: OriginJob): string => job.completed_date ?? job.end_date

const isCandidate = (typeId: number, job: OriginJob): 'copied' | 'invented' | null => {
  if (job.status === 'cancelled' || job.status === 'reverted') return null
  const activity = Number(job.activity_id)
  if (activity === ACTIVITY.copying && Number(job.blueprint_type_id) === typeId) return 'copied'
  if (activity === ACTIVITY.invention && Number(job.product_type_id) === typeId) return 'invented'
  return null
}

export const inferCopyOrigin = ({ typeId, debut, recordStart, ownerKind, jobs }: OriginInput): Origin => {
  const debutMs = Date.parse(debut)
  if (recordStart != null && debutMs <= Date.parse(recordStart)) return { kind: 'predates' }
  const windowStart = debutMs - ORIGIN_WINDOW_MS[ownerKind]
  const candidates = jobs
    .map((job) => ({ job, kind: isCandidate(typeId, job), at: Date.parse(deliveredAt(job)) }))
    .filter((c) => c.kind != null && c.at >= windowStart && c.at <= debutMs)
    // Nearest the debut first; a tie goes to the lower job id, for a stable answer.
    .sort((a, b) => b.at - a.at || String(a.job.job_id).localeCompare(String(b.job.job_id)))
  const best = candidates[0]
  if (best == null || best.kind == null) return { kind: 'unknown' }
  const location = best.job.station_id ?? best.job.facility_id
  return {
    kind: best.kind,
    jobId: String(best.job.job_id),
    locationId: location == null ? null : String(location),
    deliveredAt: deliveredAt(best.job),
    copies: Number(best.job.runs),
    licensedRuns: best.job.licensed_runs == null ? null : Number(best.job.licensed_runs),
    confidence: candidates.length === 1 ? 'high' : 'medium',
    candidates: candidates.length,
  }
}

// The one memory the server writes itself: the origin as a plain first-person
// sentence, for the page to store the first time the holder looks (author
// `origin`). The AI rewrites on top of it later. Null when there is nothing
// to say — an unknown or pre-record origin is shown, never stored, since a
// later extract cannot improve on a stored "I don't know".
export const originMemory = (
  origin: Origin,
  names: { typeName: string | null; locationName: string | null }
): string | null => {
  if (origin.kind === 'predates' || origin.kind === 'unknown') return null
  const day = origin.deliveredAt.slice(0, 10)
  const where = names.locationName != null ? ` at ${names.locationName}` : ''
  const what = names.typeName ?? 'blueprint'
  const batch =
    origin.kind === 'copied'
      ? `${origin.copies === 1 ? 'the one copy' : `one of ${origin.copies} copies`}${origin.licensedRuns != null ? `, ${origin.licensedRuns} runs each,` : ''} made from a ${what} original`
      : `${origin.copies === 1 ? 'the one attempt' : `one of ${origin.copies} attempts`} that invented a ${what}`
  const hedge =
    origin.confidence === 'high'
      ? ''
      : ` ${origin.candidates} such jobs finished around then; this was the nearest, so I may be mistaken about which.`
  return `I was ${batch} in a job that finished${where} on ${day}.${hedge}`
}
