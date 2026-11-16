// /structure/rebates — the facility tax each payer gave our structures, beside
// the tax we have given back to them by contract.
//
// Pure, so test/structureRebates.test.ts can run it under the node test runner.
//
// Two sources, both read on the caller's own session:
//
// - Paid: `industry_job_tax` entries with a positive amount in a corporation
//   wallet journal of ours. A positive entry is the facility tax a job paid to
//   the structure's owner, so it is always tax from one of our own structures.
//   `first_party_id` is the payer: a character for a personal job, the
//   corporation for a job installed as a corporation.
// - Rebated: contracts issued by one of our characters or corporations that pay
//   ISK and carry nothing else — an item exchange with a reward, no price and no
//   items — and whose title says it is a tax refund. The payee is the acceptor
//   once the contract is accepted, else the assignee.
import { contractSide, type ContractRow, type OurIds } from '../../api/graphql/contracts.ts'

export type TaxReceipt = {
  first_party_id: number | string | null
  context_id: number | string | null
  amount: number | string | null
  date: string
}

export type RebateContract = ContractRow & {
  contract_id: number | string
  assignee_id?: number | string | null
  title?: string | null
  status?: string | null
  date_issued: string
  date_expired: string
  date_completed?: string | null
}

export type RebateRow = {
  partyId: string
  paid: number
  jobs: number
  rebated: number
  rebates: number
  pending: number
  net: number
}

const isk = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

// "tax refund", "Tax rebate", "refund of industry tax" — the title names tax
// and a refund or rebate. A bare "refund" is too common to count.
export const isTaxRefundTitle = (title: string | null | undefined): boolean =>
  title != null && /\btax/i.test(title) && /\b(refund|rebate)/i.test(title)

// An ISK payment and nothing else: the issuer pays `reward`, asks no `price`,
// and the contract holds no items. `itemCount` is the number of item rows the
// contract extract stored for it.
export const isIskOnlyPayment = (contract: RebateContract, itemCount: number): boolean =>
  contract.type === 'item_exchange' && isk(contract.reward) > 0 && isk(contract.price) === 0 && itemCount === 0

export const rebatePayee = (contract: RebateContract): string | null => {
  const id = contract.acceptor_id ?? contract.assignee_id
  return id == null || Number(id) === 0 ? null : String(id)
}

export type RebateInput = {
  receipts: readonly TaxReceipt[]
  contracts: readonly RebateContract[]
  // Item rows per contract id.
  itemCounts: ReadonlyMap<string, number>
  ours: OurIds
  // The window's start (ISO). A paid rebate counts when it completed in the
  // window; an outstanding one counts while it has not expired.
  since: string
  now: string
}

// The tax contracts that are rebates, one per contract id (a contract shows up
// once per owner copy: on the issuing character and on its corporation).
export const rebateContracts = (input: Omit<RebateInput, 'receipts'>): RebateContract[] => {
  const seen = new Set<string>()
  return input.contracts.filter((c) => {
    const id = String(c.contract_id)
    if (seen.has(id)) return false
    const keep =
      contractSide(c, input.ours) === 'issuer' &&
      isTaxRefundTitle(c.title) &&
      isIskOnlyPayment(c, input.itemCounts.get(id) ?? 0) &&
      rebatePayee(c) != null
    if (keep) seen.add(id)
    return keep
  })
}

type Acc = { paid: number; jobs: Set<string>; rebated: number; rebates: number; pending: number }
const emptyAcc = (): Acc => ({ paid: 0, jobs: new Set(), rebated: 0, rebates: 0, pending: 0 })

export const foldRebates = (input: RebateInput): RebateRow[] => {
  const byParty = new Map<string, Acc>()
  const accFor = (id: string): Acc => {
    const found = byParty.get(id)
    if (found) return found
    const made = emptyAcc()
    byParty.set(id, made)
    return made
  }

  input.receipts
    .filter((r) => r.first_party_id != null && isk(r.amount) > 0 && r.date >= input.since)
    .forEach((r) => {
      const acc = accFor(String(r.first_party_id))
      acc.paid += isk(r.amount)
      if (r.context_id != null) acc.jobs.add(String(r.context_id))
    })

  rebateContracts(input).forEach((c) => {
    const payee = rebatePayee(c) as string
    if (c.status === 'finished' && c.date_completed != null && c.date_completed >= input.since) {
      const acc = accFor(payee)
      acc.rebated += isk(c.reward)
      acc.rebates += 1
    } else if (c.status === 'outstanding' && c.date_expired > input.now) {
      accFor(payee).pending += isk(c.reward)
    }
  })

  return [...byParty.entries()]
    .map(([partyId, a]) => ({
      partyId,
      paid: a.paid,
      jobs: a.jobs.size,
      rebated: a.rebated,
      rebates: a.rebates,
      pending: a.pending,
      net: a.paid - a.rebated,
    }))
    .filter((r) => r.paid > 0 || r.rebated > 0 || r.pending > 0)
    .sort((a, b) => b.paid - a.paid || b.rebated - a.rebated || a.partyId.localeCompare(b.partyId))
}
