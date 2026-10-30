// The read side of the structure-measure rollup (docs/structure-measure-
// rollup.md): a window of structure_measure_day and structure_installer_day
// rows, summed into the figures a /structure tile shows — Revenue, Taxes Paid
// (exact and estimated), Cost Avoidance's receipt basis, Your Total EIV, the
// Characters tab — and the index page's two footers. Pure; measures.ts reads
// the rows and this decides what they mean to THIS reader, which is the part
// the rollup could not settle per owner:
//
//   * own_job_tax is a cost-avoidance receipt only where one of the reader's
//     corporations owns the structure — paying a landlord we don't own is rent.
//   * recovered_tax stands only where no journal of the reader's bills the
//     structure's owner exactly (journalCoverage.ts), since the exact row wins.
//   * A row at a structure with no tile is not lost: its revenue is
//     "unaccounted" (by payer), its tax paid is "taxes paid elsewhere" (by
//     landlord), unless the landlord has a tile here — then the job merely
//     failed to resolve, and attributing it would be a guess.
import { forEach, sum } from 'ramda'

import type { OwnTaxReceipt } from './costAvoidance.ts'
import type { StructureEiv } from './eiv.ts'
import type { CharacterRow as InstallerRow } from './structureTabs.tsx'

export type MeasureWindowRow = {
  structure_id: number | string
  registration_id: string | null
  corporation_id: number | string | null
  utc_day: string
  jobs: number | string
  revenue: number | string | null
  revenue_by_payer: Record<string, number> | null
  tax_paid: number | string | null
  tax_paid_by_landlord: Record<string, number> | null
  own_job_tax: number | string | null
  own_job_tax_jobs: number | string
  eiv: number | string
  eiv_jobs: number | string
  recovered_tax: number | string
  recovered_eiv: number | string
  recovered_jobs: number | string
  unpriced_jobs: number | string
}

export type InstallerWindowRow = {
  structure_id: number | string
  registration_id: string | null
  corporation_id: number | string | null
  character_id: number | string | null
  jobs: number | string
  eiv: number | string
  installer_ids: Array<number | string> | null
  hidden_jobs: number | string
  hidden_eiv: number | string
  hidden_installer_ids: Array<number | string> | null
}

export type MeasureWindowInput = {
  // Structure ids with a tile on the page.
  onPage: ReadonlySet<string>
  // structure id -> the corporation that owns it, for every structure on the
  // page whose owner is known.
  structureOwner: ReadonlyMap<string, string>
  // The reader's own corporations.
  ownCorporationIds: ReadonlySet<string>
  // Structures whose owner's journal the reader holds rows for.
  journalCoveredStructureIds: ReadonlySet<string>
  // The corporations owning a tile on the page.
  listedOwners: ReadonlySet<string>
}

// One landlord with no tile here: what they took, and the structures the
// rollup could place the charges at (none for structure 0).
export type UnlistedLandlord = { amount: number; structureIds: Set<string> }

export type MeasureWindow = {
  revenueByStructure: Map<string, number>
  taxesPaidByStructure: Map<string, number>
  ownReceipts: OwnTaxReceipt[]
  // How many jobs the receipts cover, for the footer's sentence.
  ownReceiptJobs: number
  unlistedLandlords: Map<string, UnlistedLandlord>
  unaccounted: number
  unaccountedByParty: Map<string, number>
  eivByStructure: Map<string, StructureEiv>
  totalEiv: number
  totalRecoveredTax: number
  unpricedJobs: number
}

const bump = (into: Map<string, number>, key: string, amount: number) => into.set(key, (into.get(key) ?? 0) + amount)

export const foldMeasureWindow = (rows: readonly MeasureWindowRow[], input: MeasureWindowInput): MeasureWindow => {
  const { onPage, structureOwner, ownCorporationIds, journalCoveredStructureIds, listedOwners } = input
  const weOwn = (structureId: string) => ownCorporationIds.has(structureOwner.get(structureId) ?? '')

  const revenueByStructure = new Map<string, number>()
  const taxesPaidByStructure = new Map<string, number>()
  const ownReceipts: OwnTaxReceipt[] = []
  let ownReceiptJobs = 0
  const unlistedLandlords = new Map<string, UnlistedLandlord>()
  const unaccountedByParty = new Map<string, number>()
  const eivByStructure = new Map<string, StructureEiv>()
  let unpricedJobs = 0

  forEach((row: MeasureWindowRow) => {
    const structureId = String(row.structure_id)
    const revenue = Number(row.revenue ?? 0)
    const taxPaid = Number(row.tax_paid ?? 0)
    const ownJobTax = Number(row.own_job_tax ?? 0)

    if (!onPage.has(structureId)) {
      // Somebody paid us for a job we can't place on a tile.
      forEach(
        ([payer, amount]) => bump(unaccountedByParty, payer, Number(amount)),
        Object.entries(row.revenue_by_payer ?? {})
      )
      if (revenue > 0 && Object.keys(row.revenue_by_payer ?? {}).length === 0)
        bump(unaccountedByParty, 'unknown', revenue)
      // We paid a landlord with no tile. One who does own a tile here means
      // the job simply didn't resolve — dropped rather than guessed at.
      forEach(
        ([landlord, amount]) => {
          if (listedOwners.has(landlord)) return
          const held = unlistedLandlords.get(landlord) ?? { amount: 0, structureIds: new Set<string>() }
          held.amount += Number(amount)
          if (structureId !== '0') held.structureIds.add(structureId)
          unlistedLandlords.set(landlord, held)
        },
        Object.entries(row.tax_paid_by_landlord ?? {})
      )
      return
    }

    if (revenue > 0) bump(revenueByStructure, structureId, revenue)
    if (taxPaid > 0) bump(taxesPaidByStructure, structureId, taxPaid)
    if (ownJobTax > 0 && weOwn(structureId)) {
      ownReceipts.push({ structureId, amount: ownJobTax })
      ownReceiptJobs += Number(row.own_job_tax_jobs)
    }

    const eivJobs = Number(row.eiv_jobs)
    const recoveredJobs = Number(row.recovered_jobs)
    unpricedJobs += Number(row.unpriced_jobs)
    if (eivJobs > 0 || recoveredJobs > 0) {
      const held = eivByStructure.get(structureId) ?? {
        eiv: 0,
        jobs: 0,
        recoveredTax: 0,
        recoveredEiv: 0,
        recoveredJobs: 0,
      }
      held.eiv += Number(row.eiv)
      held.jobs += eivJobs
      if (!journalCoveredStructureIds.has(structureId)) {
        held.recoveredTax += Number(row.recovered_tax)
        held.recoveredEiv += Number(row.recovered_eiv)
        held.recoveredJobs += recoveredJobs
      }
      eivByStructure.set(structureId, held)
    }
  }, rows)

  let totalEiv = 0
  let totalRecoveredTax = 0
  eivByStructure.forEach((row) => {
    totalEiv += row.eiv
    totalRecoveredTax += row.recoveredTax
  })

  return {
    revenueByStructure,
    taxesPaidByStructure,
    ownReceipts,
    ownReceiptJobs,
    unlistedLandlords,
    unaccounted: sum([...unaccountedByParty.values()]),
    unaccountedByParty,
    eivByStructure,
    totalEiv,
    totalRecoveredTax,
    unpricedJobs,
  }
}

export type InstallerWindowInput = {
  // registration uuid -> { name, characterId }: our own registrations, plus
  // co-tenants' resolved through the character directory.
  registrations: ReadonlyMap<string, { name: string; characterId: string | null }>
  // corporation id -> name, from the `corporation` directory.
  corporationNames: ReadonlyMap<string, string>
}

// The Characters tab per structure, busiest first (the order installers.ts
// always used). A registration row is one character; a corporation row is the
// corporation, with every distinct installer across the window counted. The
// hidden_* columns are the owner's own view of their hidden jobs — zero for
// anyone else, by the view's definition — so adding them back is right for
// whoever can see them.
export const foldInstallerWindow = (
  rows: readonly InstallerWindowRow[],
  input: InstallerWindowInput
): Map<string, InstallerRow[]> => {
  const byStructure = new Map<string, Map<string, InstallerRow & { seen: Set<string> }>>()
  forEach((r: InstallerWindowRow) => {
    const structureId = String(r.structure_id)
    const roster = byStructure.get(structureId) ?? new Map<string, InstallerRow & { seen: Set<string> }>()
    let key: string
    let name: string
    let kind: InstallerRow['kind']
    const seen: string[] = []
    if (r.corporation_id != null) {
      const corporationId = String(r.corporation_id)
      key = `corp:${corporationId}`
      name = input.corporationNames.get(corporationId) ?? `Corporation #${corporationId}`
      kind = 'corporation'
      seen.push(...[...(r.installer_ids ?? []), ...(r.hidden_installer_ids ?? [])].map(String))
    } else {
      const registrationId = String(r.registration_id)
      const registration = input.registrations.get(registrationId)
      const characterId = r.character_id != null ? String(r.character_id) : (registration?.characterId ?? null)
      key = characterId != null ? `char:${characterId}` : `reg:${registrationId}`
      name = registration?.name ?? 'Unknown character'
      kind = 'character'
      seen.push(characterId ?? `reg:${registrationId}`)
    }
    const row = roster.get(key) ?? { key, name, kind, jobs: 0, eiv: 0, characters: 0, seen: new Set<string>() }
    row.jobs += Number(r.jobs) + Number(r.hidden_jobs)
    row.eiv += Number(r.eiv) + Number(r.hidden_eiv)
    forEach((id: string) => row.seen.add(id), seen)
    roster.set(key, row)
    byStructure.set(structureId, roster)
  }, rows)

  return new Map(
    [...byStructure.entries()].map(([structureId, roster]) => [
      structureId,
      [...roster.values()]
        .map(({ seen, ...row }) => ({ ...row, characters: seen.size }))
        .sort((a, b) => b.eiv - a.eiv || b.jobs - a.jobs || a.name.localeCompare(b.name)),
    ])
  )
}
