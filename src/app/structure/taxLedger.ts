// Which industry_job_tax journal entries are revenue, which are the basis for
// cost avoidance, and which are neither.
//
// An `industry_job_tax` entry in one of our corporations' wallets cuts both
// ways, and the sign is not the whole story:
//
//   +  Somebody paid tax into one of our structures. Real ISK arrived, so it is
//      revenue. It is ALSO an own-rate receipt when the job that generated it
//      was one of ours — a member installing a personal job pays it out of
//      their own wallet into the corp's, and that is a bill we paid ourselves.
//
//   -  Our corporation paid the tax. A job installed AS THE CORPORATION bills
//      the corp wallet rather than the installer's, and when that corporation
//      also owns the structure, CCP writes only this outgoing side: the ISK
//      never leaves the entity, so there is no matching receipt to pair it
//      with. It is not revenue — nothing arrived — but it is exactly the
//      own-rate charge cost avoidance scales, and dropping it made a corp that
//      runs everything under corp ownership report no avoidance at all.
//
//   -  ...unless the structure belongs to somebody else, in which case we
//      really did pay a landlord. Neither revenue nor avoidance.
//
// The structure's owner is the discriminator, compared against the corporation
// whose wallet the entry sits in. Two of our own corporations trading tax
// between themselves fails that test on purpose: ISK moved, and the receiving
// corp's journal carries the positive side, which is where it gets counted.
import type { OwnTaxReceipt } from './costAvoidance'

export type TaxEntry = {
  amount: number
  // The corporation whose wallet this entry belongs to. For a negative amount,
  // the corporation that paid.
  corporationId: string | null
  // Candidate job ids for this entry, in priority order: the context_id first,
  // then any numeric tokens scraped out of an older entry's description.
  jobIds: readonly string[]
  // The party that paid, for the unaccounted breakdown.
  payerId: string | null
}

export type TaxLedgerInput = {
  // job id -> the structure it ran in, for every job we could resolve.
  structureByJob: ReadonlyMap<string, string>
  // The jobs that are OURS — our characters' and our corporations'. Jobs
  // resolved only through industry_job_tax_facility() are other players'
  // renting our slots and are deliberately absent.
  ownJobIds: ReadonlySet<string>
  // structure id -> the corporation that owns it. Covers every structure on
  // the page, which includes alliance-mates' as well as our own.
  structureOwner: ReadonlyMap<string, string>
}

export type TaxLedger = {
  revenueByStructure: Map<string, number>
  ownReceipts: OwnTaxReceipt[]
  // Revenue we received but couldn't tie to a structure on the page.
  unaccounted: number
  unaccountedByParty: Map<string, number>
}

export const foldTaxLedger = (entries: readonly TaxEntry[], input: TaxLedgerInput): TaxLedger => {
  const { structureByJob, ownJobIds, structureOwner } = input

  const revenueByStructure = new Map<string, number>()
  const unaccountedByParty = new Map<string, number>()
  const ownReceipts: OwnTaxReceipt[] = []
  // One receipt per job. A job can only be charged its facility tax once, so a
  // second entry naming it is the other side of the same charge, not a second
  // one — counting both would double the avoidance.
  const credited = new Set<string>()
  let unaccounted = 0

  const credit = (jobId: string, structureId: string, amount: number) => {
    if (credited.has(jobId)) return
    credited.add(jobId)
    ownReceipts.push({ structureId, amount })
  }

  for (const entry of entries) {
    const { amount } = entry
    if (!Number.isFinite(amount) || amount === 0) continue

    const jobId = entry.jobIds.find((token) => structureByJob.has(token))
    const structureId = jobId != null ? structureByJob.get(jobId) : undefined

    if (amount > 0) {
      if (structureId != null) {
        revenueByStructure.set(structureId, (revenueByStructure.get(structureId) ?? 0) + amount)
        if (jobId != null && ownJobIds.has(jobId)) credit(jobId, structureId, amount)
      } else {
        // Tax we received but can't tie to one of our structures (e.g. jobs not
        // in our tables, or a structure we've stopped monitoring).
        unaccounted += amount
        const party = entry.payerId ?? 'unknown'
        unaccountedByParty.set(party, (unaccountedByParty.get(party) ?? 0) + amount)
      }
      continue
    }

    // Outgoing. Only a charge our corporation levied on itself is avoidance;
    // one paid to another owner is a real expense and belongs to neither
    // figure, so it is dropped rather than falling into "unaccounted" (which
    // is a revenue bucket).
    if (jobId == null || structureId == null) continue
    if (entry.corporationId == null) continue
    if (structureOwner.get(structureId) !== entry.corporationId) continue
    credit(jobId, structureId, -amount)
  }

  return { revenueByStructure, ownReceipts, unaccounted, unaccountedByParty }
}
