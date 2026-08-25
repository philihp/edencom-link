// Which industry_job_tax journal entries are revenue, which are tax we paid,
// which are the basis for cost avoidance, and which are none of those.
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
//
// TAXES PAID is the third measure, and it is not the negation of revenue: it is
// every charge OUR side actually paid, on our structures and other people's
// alike. An alt corp is ours (we hold a director in it, which is the only
// reason its wallet is readable at all), so it is classified exactly like one
// of our characters.
//
// Each charge counts once, which decides which side of a pair to read it from:
//
//   - An OUTGOING entry is always tax we paid, so it is counted there.
//   - An INCOMING entry counts only when a CHARACTER of ours installed the job.
//     Their wallet paid it and we have no character journal to read, so the
//     receipt is the only record. A corp job's payment is already visible as
//     the outgoing entry in that corp's own wallet, so counting the incoming
//     side too would bill one charge twice.
//
// COST AVOIDANCE is the one that turns on OWNERSHIP, and it is where the ISK is:
// a job WE initiated, run in a structure WE own, was billed our own rate, and
// the gap to a public rate is the expense never incurred. Whether the job was
// installed by a character or as a corporation does not enter into it — the tax
// is levied on the job either way, and either way we kept it.
//
// So the test is: is the job ours, and does one of our corporations own the
// structure. NOT whether the installing corporation is the owning one. Those
// differ exactly when one of our corps runs a job in another of our corps'
// structure, which is a saving like any other — the ISK stays with us. Reading
// it as a corporation-identity match dropped that case, and with it the whole
// figure for anyone whose characters sit in a corp that owns no structures.
//
// Paying a landlord we do not own — an ally's structure, or a stranger's — is
// rent. It is tax paid, and no saving at all.
import { find, forEach, sum } from 'ramda'

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
  // The party that was paid. On an outgoing entry that is the landlord, which
  // is how tax leaving for a structure this page doesn't list is attributed to
  // a corporation without resolving the structure at all.
  recipientId: string | null
}

export type TaxLedgerInput = {
  // job id -> the structure it ran in, for every job we could resolve.
  structureByJob: ReadonlyMap<string, string>
  // The jobs that are OURS — our characters' and our corporations' alike. Which
  // of the two it was does not matter to avoidance: a job we initiated in a
  // structure we own is billed our own rate either way. Jobs resolved only
  // through industry_job_tax_facility() are other players' renting our slots
  // and are deliberately absent.
  ownJobIds: ReadonlySet<string>
  // The subset of those installed by a CHARACTER rather than as a corporation.
  // This decides nothing about avoidance; it exists only so one charge is
  // billed once. A corp job's payment is readable as the outgoing entry in the
  // paying corp's own wallet, so counting the landlord's receipt too would
  // double it — a character's payment has no such entry to read.
  personalJobIds: ReadonlySet<string>
  // Our own corporations. A structure one of them owns is a structure we own,
  // whichever of our corps installed the job — that is what separates a saving
  // from rent.
  ownCorporationIds: ReadonlySet<string>
  // structure id -> the corporation that owns it. Covers every structure on
  // the page, which includes alliance-mates' as well as our own.
  structureOwner: ReadonlyMap<string, string>
  // The corporations owning a structure on the page. A charge paid to anyone
  // else went to a landlord this page doesn't list, which is the whole test for
  // the unlisted bucket — the job needn't resolve for that to be known.
  listedOwners: ReadonlySet<string>
}

// One outgoing charge to a landlord with no tile here. `jobId` is kept so the
// caller can resolve where it ran; the corporation is already known.
export type UnlistedTaxPayment = {
  corporationId: string | null
  jobId: string | null
  amount: number
}

export type TaxLedger = {
  revenueByStructure: Map<string, number>
  // Tax we actually paid, positive, keyed by the structure it was paid for —
  // ours or somebody else's. Overlaps revenueByStructure on purpose where a
  // member paid their own corp: one charge, two true statements about it.
  taxesPaidByStructure: Map<string, number>
  ownReceipts: OwnTaxReceipt[]
  // Tax paid to corporations owning no structure on this page. Kept apart from
  // taxesPaidByStructure rather than dropped: it is real ISK that left, and
  // folding it into a per-structure figure would attribute it to a tile that
  // doesn't exist.
  unlistedPayments: UnlistedTaxPayment[]
  // Revenue we received but couldn't tie to a structure on the page.
  unaccounted: number
  unaccountedByParty: Map<string, number>
}

export const foldTaxLedger = (entries: readonly TaxEntry[], input: TaxLedgerInput): TaxLedger => {
  const { structureByJob, ownJobIds, personalJobIds, ownCorporationIds, structureOwner, listedOwners } = input

  const revenueByStructure = new Map<string, number>()
  const taxesPaidByStructure = new Map<string, number>()
  const unaccountedByParty = new Map<string, number>()
  const ownReceipts: OwnTaxReceipt[] = []
  const unlistedPayments: UnlistedTaxPayment[] = []
  // One receipt per job, and one payment per job. A job can only be charged its
  // facility tax once, so a second entry naming it is the other side of the
  // same charge, not a second one — counting both would double the figure.
  const credited = new Set<string>()
  const paid = new Set<string>()

  // Every per-key total here accumulates the same way. Mutating the map rather
  // than rebuilding it per entry is the accepted shape for a fold this size.
  // Ours if one of our corporations owns it. An alliance-mate's tile is on this
  // page too, and paying them is rent, not a saving.
  const weOwn = (structureId: string) => ownCorporationIds.has(structureOwner.get(structureId) ?? '')

  const bump = (into: Map<string, number>, key: string, amount: number) => into.set(key, (into.get(key) ?? 0) + amount)

  const credit = (jobId: string, structureId: string, amount: number) => {
    if (credited.has(jobId)) return
    credited.add(jobId)
    ownReceipts.push({ structureId, amount })
  }

  const payTax = (jobId: string, structureId: string, amount: number) => {
    if (paid.has(jobId)) return
    paid.add(jobId)
    bump(taxesPaidByStructure, structureId, amount)
  }

  forEach((entry: TaxEntry) => {
    const { amount } = entry
    if (!Number.isFinite(amount) || amount === 0) return

    const jobId = find((token: string) => structureByJob.has(token), entry.jobIds)
    const structureId = jobId != null ? structureByJob.get(jobId) : undefined

    if (amount > 0) {
      if (structureId != null) {
        bump(revenueByStructure, structureId, amount)
        // Somebody paid us. If it was one of our own characters, that payment is
        // recorded nowhere else — no character wallet journal is ingested — so
        // this receipt is the only record of tax we paid.
        if (jobId != null && personalJobIds.has(jobId)) payTax(jobId, structureId, amount)
        // And a job of ours run in a structure of ours was billed our own rate,
        // which is the charge the counterfactual scales. A corp job's receipt
        // reaches us only when a DIFFERENT corp installed it, so the credit is
        // gated on the job being ours rather than on which wallet paid.
        if (jobId != null && ownJobIds.has(jobId) && weOwn(structureId)) credit(jobId, structureId, amount)
      } else {
        // Tax we received but can't tie to one of our structures (e.g. jobs not
        // in our tables, or a structure we've stopped monitoring).
        bump(unaccountedByParty, entry.payerId ?? 'unknown', amount)
      }
      return
    }

    // Outgoing: our corporation paid this, so it is tax we paid whoever owns the
    // structure.
    if (jobId == null || structureId == null) {
      // No tile to attribute it to. If the landlord owns nothing on this page,
      // that is because they are somebody else entirely, and the charge belongs
      // in the unlisted bucket. If they DO own a tile here, the job simply
      // didn't resolve — attributing it to a structure we cannot name would be
      // a guess, so it is dropped as before.
      const recipient = entry.recipientId
      if (recipient == null || !listedOwners.has(recipient)) {
        unlistedPayments.push({ corporationId: recipient, jobId: entry.jobIds[0] ?? null, amount: -amount })
      }
      return
    }
    payTax(jobId, structureId, -amount)

    // ...and it is a saving whenever the structure is ours: we initiated the job
    // (our wallet paid for it) and kept the tax inside the group. Paying a
    // landlord we don't own — an ally's structure, or a stranger's — is a real
    // expense and no saving at all.
    if (!weOwn(structureId)) return
    credit(jobId, structureId, -amount)
  }, entries)

  return {
    revenueByStructure,
    taxesPaidByStructure,
    ownReceipts,
    unlistedPayments,
    // The same figure the breakdown adds up to, so the two can never disagree.
    unaccounted: sum([...unaccountedByParty.values()]),
    unaccountedByParty,
  }
}
