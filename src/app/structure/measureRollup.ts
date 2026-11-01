// The write side of the structure-measure rollup (docs/structure-measure-
// rollup.md): one OWNER's industry jobs and industry-tax journal entries, folded
// into the per-(structure, owner, UTC day) rows of structure_measure_day and
// structure_installer_day_all. Pure — the extracts' writer
// (src/jobs/structureMeasures.js) reads the inputs, calls this, and upserts
// what comes back; test/structureMeasureRollup.test.ts pins the rules.
//
// An owner is a registration (one character of one account) or a corporation.
// The page's figures are per account, and an account is a set of owners, so
// every figure here has to be decomposable per owner: an account's Revenue is
// the sum of its corporations' rows, its EIV the sum of its registrations'.
// That decides where each charge is filed:
//
//   * A job's facility tax is filed ONCE, under the owner whose wallet paid it.
//     A job installed as a corporation bills the corporation's wallet (the
//     outgoing journal entry), so it is the corporation's charge. A personal
//     job bills the character's wallet, which has no journal here; the receipt
//     in the landlord's wallet is its only record, so the registration takes
//     the receipt — but only when no outgoing entry names the job, since ESI's
//     character listing includes corp-installed jobs too, and those are
//     already the corporation's.
//   * EIV is filed under the registration whose character installed the job,
//     personally or as a corporation: Your Total EIV counts only jobs OUR
//     characters installed, and a corporation's row cannot know which of its
//     installers the reader holds. A corp job whose installer is registered
//     nowhere is nobody's throughput, exactly as the page always read it.
//   * Revenue is filed under the corporation whose WALLET received it, at the
//     structure the job ran in — or at structure 0, "no job we hold", which
//     the page reads as unaccounted. Both sides of a charge inside one group
//     (a member paying their own corp) are two true rows: revenue for the
//     corp, tax paid for the member.
//
// What the rollup cannot decide is left as a basis for the page: own_job_tax is
// every charge on a job of this owner's, and whether it was billed at our OWN
// rate (and so counts toward cost avoidance) turns on whether the reader's
// corporations own the structure; the recovered tax is stored always, and
// whether a journal of the reader's already bills that structure exactly is
// decided when read (src/app/structure/measureWindow.ts).
import { forEach, uniqBy } from 'ramda'

import { INDEX_ACTIVITY, isPriceable, priceJobEiv, recoverFacilityTax, type EivPricing } from './eiv.ts'

// A current row of either industry-job table, as the writer selects it. A
// character row names the registration; a corp row the corporation and the
// character who installed it.
export type RollupJob = {
  job_id: number | string
  registration_id?: string | null
  corporation_id?: number | string | null
  installer_id?: number | string | null
  activity_id?: number | string | null
  blueprint_type_id?: number | string | null
  runs?: number | string | null
  cost?: number | string | null
  start_date: string
  station_id?: number | string | null
  facility_id?: number | string | null
}

// An industry_job_tax entry of corp_wallet_journal: corporation_id is the
// wallet it sits in, context_id the job.
export type RollupEntry = {
  corporation_id: number | string
  amount: number | string | null
  date: string
  context_id?: number | string | null
  first_party_id?: number | string | null
  second_party_id?: number | string | null
}

export type RollupOwner =
  { kind: 'registration'; id: string; characterId: string | null } | { kind: 'corporation'; id: string }

// The key a job's index probe is filed under; the writer asks
// industry_index_at() for every (system, activity, install moment) and hands
// the answers back keyed this way.
export const indexProbeKey = (systemId: string, activity: string, asOf: string): string =>
  `${systemId}:${activity}:${asOf}`

export type OwnerFoldInput = {
  owner: RollupOwner
  // Registration: its character-table jobs. Corporation: unused.
  personalJobs: readonly RollupJob[]
  // Registration: the corp-table jobs its character installed, in any
  // corporation. Corporation: the corporation's own corp-table jobs.
  corpJobs: readonly RollupJob[]
  // Every industry_job_tax entry naming any of those jobs, by job id, from
  // every wallet the deployment holds.
  entriesByJob: ReadonlyMap<string, readonly RollupEntry[]>
  // Corporation: the industry_job_tax entries in its own wallet over the days
  // being recomputed, both signs — revenue, and outgoing charges for jobs the
  // extract never listed. Registration: unused.
  walletEntries: readonly RollupEntry[]
  // job id -> the structure it ran in, for every job a wallet entry names that
  // this owner does not hold (resolved by the writer over both tables, any
  // owner). A job absent here files at structure 0.
  jobLocations: ReadonlyMap<string, number>
  // Corporation: installer ids that have a registration row anywhere. An
  // unregistered member's personal job paying into the corporation's own
  // structure is still an own-rate charge on a job of the corporation's, and
  // no registration row will ever file it.
  registeredInstallerIds: ReadonlySet<string>
  // industry_job_hidden, for the Characters tab's hidden_* split.
  hiddenJobIds: ReadonlySet<string>
  pricing: EivPricing
  // indexProbeKey(system, activity, start_date) -> cost index at install.
  indexes: ReadonlyMap<string, number>
  // structure id -> system id / hull type id, for the index fee.
  systemOf: ReadonlyMap<string, string>
  hullOf: ReadonlyMap<string, number | null>
}

export type MeasureDayRow = {
  structure_id: number
  registration_id: string | null
  corporation_id: number | null
  utc_day: string
  jobs: number
  revenue: number
  revenue_by_payer: Record<string, number>
  tax_paid: number
  tax_paid_by_landlord: Record<string, number>
  own_job_tax: number
  own_job_tax_jobs: number
  eiv: number
  eiv_jobs: number
  recovered_tax: number
  recovered_eiv: number
  recovered_jobs: number
  unpriced_jobs: number
}

export type InstallerDayRow = {
  structure_id: number
  registration_id: string | null
  corporation_id: number | null
  utc_day: string
  character_id: number | null
  jobs: number
  eiv: number
  installer_ids: number[]
  hidden_jobs: number
  hidden_eiv: number
  hidden_installer_ids: number[]
}

// ISO timestamps from ESI ("…Z") and PostgREST ("…+00:00") both open with the
// UTC calendar date.
export const utcDayOf = (iso: string): string => iso.slice(0, 10)

// Where a job ran: Upwell structures share the id between station_id and
// facility_id, NPC stations carry only station_id (the jobLocationId
// precedence). The rollup keeps stations too — the page decides what has a
// tile — and 0 stands for "no location at all".
export const jobLocationOf = (job: Pick<RollupJob, 'station_id' | 'facility_id'>): number => {
  const id = Number(job.station_id ?? job.facility_id)
  return Number.isFinite(id) && id > 0 ? id : 0
}

const bump = (into: Record<string, number>, key: string, amount: number) => {
  into[key] = (into[key] ?? 0) + amount
}

const jobKey = (job: RollupJob) => String(job.job_id)

export const foldOwnerDays = (input: OwnerFoldInput): { measures: MeasureDayRow[]; installers: InstallerDayRow[] } => {
  const { owner, entriesByJob, hiddenJobIds, pricing, indexes, systemOf, hullOf } = input
  const isRegistration = owner.kind === 'registration'
  const ownerColumns =
    owner.kind === 'registration'
      ? { registration_id: owner.id, corporation_id: null }
      : { registration_id: null, corporation_id: Number(owner.id) }

  // Push-mutated maps keyed `${structure}|${day}`: the accepted shape for a
  // fold that builds rows.
  const measures = new Map<string, MeasureDayRow>()
  const installers = new Map<string, InstallerDayRow>()
  const measureRow = (structureId: number, day: string): MeasureDayRow => {
    const key = `${structureId}|${day}`
    const held = measures.get(key)
    if (held) return held
    const row: MeasureDayRow = {
      structure_id: structureId,
      ...ownerColumns,
      utc_day: day,
      jobs: 0,
      revenue: 0,
      revenue_by_payer: {},
      tax_paid: 0,
      tax_paid_by_landlord: {},
      own_job_tax: 0,
      own_job_tax_jobs: 0,
      eiv: 0,
      eiv_jobs: 0,
      recovered_tax: 0,
      recovered_eiv: 0,
      recovered_jobs: 0,
      unpriced_jobs: 0,
    }
    measures.set(key, row)
    return row
  }
  const installerRow = (structureId: number, day: string): InstallerDayRow => {
    const key = `${structureId}|${day}`
    const held = installers.get(key)
    if (held) return held
    const row: InstallerDayRow = {
      structure_id: structureId,
      ...ownerColumns,
      utc_day: day,
      character_id: owner.kind === 'registration' && owner.characterId != null ? Number(owner.characterId) : null,
      jobs: 0,
      eiv: 0,
      installer_ids: [],
      hidden_jobs: 0,
      hidden_eiv: 0,
      hidden_installer_ids: [],
    }
    installers.set(key, row)
    return row
  }

  // The charge a job's entries record, split by side. Amounts are summed in
  // case ESI ever splits one charge, but a job is charged once, so each side
  // is normally one entry.
  const chargeOf = (job: RollupJob) => {
    const entries = entriesByJob.get(jobKey(job)) ?? []
    let outgoing = 0
    let incoming = 0
    const landlords: Record<string, number> = {}
    forEach((entry: RollupEntry) => {
      const amount = Number(entry.amount ?? 0)
      if (!Number.isFinite(amount) || amount === 0) return
      if (amount < 0) {
        outgoing += -amount
        // Who was paid: the entry's second party is the landlord corporation.
        bump(landlords, entry.second_party_id != null ? String(entry.second_party_id) : 'unknown', -amount)
      } else {
        incoming += amount
        // A receipt sits in the landlord's own wallet.
        bump(landlords, String(entry.corporation_id), amount)
      }
    }, entries)
    return { outgoing, incoming, landlords, billed: entries.length > 0 }
  }

  // The jobs this owner HOLDS: a registration its personal jobs, a corporation
  // its corp-table jobs. These carry the job count, the tax charges and the
  // Characters tab row.
  const heldJobs = isRegistration ? input.personalJobs : input.corpJobs
  const heldJobIds = new Set(heldJobs.map(jobKey))
  // A registration's personal job that the corp extract also lists is one job,
  // and the tab files it under the corporation (a corp attribution wins).
  const corpListed = new Set(isRegistration ? input.corpJobs.map(jobKey) : [])

  forEach((job: RollupJob) => {
    const structureId = jobLocationOf(job)
    const day = utcDayOf(job.start_date)
    const m = measureRow(structureId, day)
    m.jobs += 1

    const { outgoing, incoming, landlords } = chargeOf(job)
    if (isRegistration) {
      // The receipt is the registration's charge only when the character's
      // wallet paid it — an outgoing entry means the job was installed as a
      // corporation, whose row has it.
      if (outgoing === 0 && incoming > 0) {
        m.tax_paid += incoming
        m.own_job_tax += incoming
        m.own_job_tax_jobs += 1
        forEach(([landlord, amount]) => bump(m.tax_paid_by_landlord, landlord, amount), Object.entries(landlords))
      }
    } else if (outgoing > 0) {
      m.tax_paid += outgoing
      m.own_job_tax += outgoing
      m.own_job_tax_jobs += 1
      forEach(([landlord, amount]) => bump(m.tax_paid_by_landlord, landlord, amount), Object.entries(landlords))
    } else if (
      incoming > 0 &&
      (job.installer_id == null || !input.registeredInstallerIds.has(String(job.installer_id)))
    ) {
      // A member nobody registered paid their own corporation: not tax WE
      // paid, but a charge on a job of the corporation's — the avoidance
      // basis, if the reader owns the structure.
      m.own_job_tax += incoming
      m.own_job_tax_jobs += 1
    }

    if (isRegistration && corpListed.has(jobKey(job))) return
    const priced = priceJobEiv(job, pricing)
    const eiv = priced != null && 'eiv' in priced ? priced.eiv : 0
    const row = installerRow(structureId, day)
    const installer = job.installer_id != null ? Number(job.installer_id) : null
    if (hiddenJobIds.has(jobKey(job))) {
      row.hidden_jobs += 1
      row.hidden_eiv += eiv
      if (!isRegistration && installer != null && !row.hidden_installer_ids.includes(installer)) {
        row.hidden_installer_ids.push(installer)
      }
    } else {
      row.jobs += 1
      row.eiv += eiv
      if (!isRegistration && installer != null && !row.installer_ids.includes(installer)) {
        row.installer_ids.push(installer)
      }
    }
  }, heldJobs)

  // Your Total EIV and the recovered tax: every job this registration's
  // character installed, one per job id whichever extract listed it.
  if (isRegistration) {
    const installed = uniqBy(jobKey, [...input.personalJobs, ...input.corpJobs])
    forEach((job: RollupJob) => {
      if (!isPriceable(job)) return
      const structureId = jobLocationOf(job)
      const day = utcDayOf(job.start_date)
      const m = measureRow(structureId, day)
      const priced = priceJobEiv(job, pricing)
      if (priced == null) return
      if ('missing' in priced) {
        m.unpriced_jobs += 1
        return
      }
      m.eiv += priced.eiv
      m.eiv_jobs += 1

      // Recovery: never for a job the journal recorded (either side), and
      // only with a real cost to invert.
      if (chargeOf(job).billed) return
      const cost = Number(job.cost)
      if (!Number.isFinite(cost) || cost <= 0) return
      const systemId = systemOf.get(String(structureId))
      const activity = INDEX_ACTIVITY[Number(job.activity_id)]
      const costIndex = systemId != null ? indexes.get(indexProbeKey(systemId, activity, job.start_date)) : undefined
      if (costIndex == null) {
        m.unpriced_jobs += 1
        return
      }
      m.recovered_tax += recoverFacilityTax({
        eiv: priced.eiv,
        cost,
        costIndex,
        hullTypeId: hullOf.get(String(structureId)),
      })
      m.recovered_eiv += priced.eiv
      m.recovered_jobs += 1
    }, installed)
  }

  // A corporation's wallet: what arrived is revenue, filed at the job's
  // structure; what left for a job this extract never listed is still tax
  // paid, filed at structure 0 with its landlord so the page can total it
  // under "taxes paid elsewhere".
  if (!isRegistration) {
    forEach((entry: RollupEntry) => {
      const amount = Number(entry.amount ?? 0)
      if (!Number.isFinite(amount) || amount === 0) return
      const day = utcDayOf(entry.date)
      const contextId = entry.context_id != null ? String(entry.context_id) : null
      if (amount > 0) {
        const structureId = contextId != null ? (input.jobLocations.get(contextId) ?? 0) : 0
        const m = measureRow(structureId, day)
        m.revenue += amount
        bump(m.revenue_by_payer, entry.first_party_id != null ? String(entry.first_party_id) : 'unknown', amount)
        return
      }
      if (contextId != null && heldJobIds.has(contextId)) return
      const m = measureRow(0, day)
      m.tax_paid += -amount
      bump(m.tax_paid_by_landlord, entry.second_party_id != null ? String(entry.second_party_id) : 'unknown', -amount)
    }, input.walletEntries)
  }

  return { measures: [...measures.values()], installers: [...installers.values()] }
}
