// Cost avoidance on industry facility tax — the accounting name for an expense
// never incurred because a resource you already own did the work, as against a
// cost saving, which is a bill that got smaller. Nothing changed hands, so it
// is reported beside revenue rather than added to it.
//
// Every job one of our characters or corporations installed in a structure we
// own paid our own members rate into our own wallet. In somebody else's public
// structure it would have paid theirs and kept none of it, and the gap between
// the two rates on the same job is the expense we avoided.
//
// The arithmetic runs off the tax we were paid, not off the job's `cost`. ESI
// documents `cost` as "the sum of job installation fee and industry facility
// tax", and the tax inside it is levied on the job's Estimated Item Value —
// a different, larger number than the fee, and one we cannot compute without
// CCP's adjusted_price feed (which nothing here ingests). The tax receipt sits
// on the other side of that unknown: the journal amount IS eiv * own_rate, so
//
//   eiv      = tax_received / own_rate
//   avoided  = eiv * (public_rate - own_rate)
//            = tax_received * (public_rate / own_rate - 1)
//
// which needs neither the EIV, the system cost index, nor the structure's role
// bonus. It is exact given the two declared rates.

export type OwnTaxReceipt = {
  structureId: string
  // ISK of industry_job_tax we were paid for one job of our own.
  amount: number
}

export type CostAvoidance = {
  // Null when the own rate is zero: nothing was billed, so there is no receipt
  // to scale and the saving is unknowable rather than infinite. Every other
  // field still describes what was found.
  total: number | null
  // Largest first, so a caller can render the breakdown straight off it.
  byStructure: Array<[structureId: string, avoided: number]>
  // Tax we actually billed ourselves — the figure this is derived from.
  billed: number
  // What the same jobs would have been billed at the public rate.
  counterfactual: number | null
  jobs: number
}

export const costAvoidance = (
  receipts: readonly OwnTaxReceipt[],
  rates: { own: number; public: number }
): CostAvoidance => {
  const billed = receipts.reduce((sum, r) => sum + r.amount, 0)

  // A public rate declared below your own gives a negative saving, which is
  // the honest answer to the question and so is not clamped.
  const multiple = rates.own > 0 ? rates.public / rates.own : null

  const byStructure = new Map<string, number>()
  if (multiple != null) {
    for (const receipt of receipts) {
      const avoided = receipt.amount * (multiple - 1)
      byStructure.set(receipt.structureId, (byStructure.get(receipt.structureId) ?? 0) + avoided)
    }
  }

  return {
    total: multiple == null ? null : billed * (multiple - 1),
    byStructure: [...byStructure.entries()].sort((a, b) => b[1] - a[1]),
    billed,
    counterfactual: multiple == null ? null : billed * multiple,
    jobs: receipts.length,
  }
}
