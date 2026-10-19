// The figures a /structure tile leads with — Your Total EIV, Taxes Paid (exact
// and estimated), Revenue, Cost Avoidance — as label/value pairs for a
// `styles.fields` grid. The index tile and /structure/[structureId] both render
// this one component over the same fold (./measures.ts), so the detail page
// shows every number its tile does, by construction.
import { formatIsk } from '../isk'
import { formatRate } from '../settings/tax/rates'
import { recoveredRate } from './eiv'
import { HelpTip } from './helpTip'
import type { StructureMeasures } from './measures'
import styles from './structures.module.css'

export const MeasureFields = ({ structureId, measures }: { structureId: string; measures: StructureMeasures }) => {
  // Receipts come from corp_wallet_journal, whose RLS is own-corps only — so,
  // exactly like the Revenue beside it, avoidance shows only to callers who can
  // read that corp's ledger.
  const avoided = new Map(measures.avoidance.byStructure).get(structureId)
  const row = measures.eiv.byStructure.get(structureId)
  const journalPaid = measures.ledger.taxesPaidByStructure.get(structureId)
  const revenue = measures.ledger.revenueByStructure.get(structureId)
  const hasMeasures =
    (row != null && (row.eiv > 0 || row.recoveredJobs > 0)) || journalPaid != null || revenue != null || avoided != null
  // A journal receipt is exact and wins; the recovered
  // estimate stands in where no journal can see the
  // charge. Either way the rate is the tax against
  // this structure's EIV over the same window — and 0
  // is shown, not hidden: it means the owner charges
  // nothing, while the index fee and SCC surcharge in
  // the job cost went to CCP, not to them.
  const rate = row != null ? recoveredRate(row) : null
  return (
    <>
      {hasMeasures && (
        <HelpTip
          text={[
            "Your Total EIV — the Estimated Item Value of the manufacturing and reaction jobs your own characters installed here in the window: your industrial impact on the system's cost index. Co-tenants' jobs, and corp jobs installed by corpmates you have no registration for, are not counted. The index fee, the owner's facility tax, and the 4% SCC surcharge are all charged as fractions of it — think of it as your market share of the system's industry.",
            "Taxes Paid — facility tax paid to this structure's owner: exact from the corp wallet journal where we can read it, estimated from job costs elsewhere (cost minus index fee minus 4% SCC surcharge). The subtracted fees are ~14× the typical tax, so the estimate resolves whole fractions of a percent at best: ≈0% means at or below what it can distinguish from free, not that the owner provably charges nothing.",
            'Revenue — industry tax received into our corp wallets from jobs run in this structure.',
            'Cost Avoidance — facility tax never incurred because our own jobs ran at our own rate instead of a public one.',
          ].join('\n\n')}
        />
      )}
      {row != null && row.eiv > 0 && (
        <>
          <span className={styles.label}>your total EIV</span>
          <span className={`${styles.value} ${styles.num}`}>{formatIsk(row.eiv)}</span>
        </>
      )}
      {journalPaid != null && (
        <>
          <span className={styles.label}>taxes paid</span>
          <span className={`${styles.value} ${styles.num}`}>
            {formatIsk(journalPaid)}
            {row != null && row.eiv > 0 && (
              <span className={styles.hoverPct}>≈{formatRate(journalPaid / row.eiv)} of EIV</span>
            )}
          </span>
        </>
      )}
      {/* Not an else: the ledger's paidJobIds keeps recovery off every
          journal-billed job, so the two figures are disjoint shares of
          the same structure — corp-installed jobs land in the exact row
          above, personal jobs at a rented structure only in this one.
          A mixed structure legitimately shows both. */}
      {row != null && row.recoveredJobs > 0 && (
        <>
          <span className={styles.label}>taxes paid (est.)</span>
          <span className={`${styles.value} ${styles.num}`}>
            {formatIsk(row.recoveredTax)}
            {rate != null && <span className={styles.hoverPct}>≈{formatRate(rate)} of EIV</span>}
          </span>
        </>
      )}
      {revenue != null && (
        <>
          <span className={styles.label}>revenue</span>
          <span className={`${styles.value} ${styles.num}`}>{formatIsk(revenue)}</span>
        </>
      )}
      {avoided != null && (
        <>
          <span className={styles.label}>cost avoidance</span>
          <span className={`${styles.value} ${styles.num}`}>{formatIsk(avoided ?? 0)}</span>
        </>
      )}
    </>
  )
}
