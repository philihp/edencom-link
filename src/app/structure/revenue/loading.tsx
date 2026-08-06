import { LoadingShell, SkeletonTable } from '../../skeleton'

const RevenueLoading = () => (
  <LoadingShell title="Tax Revenue">
    <SkeletonTable
      columns={['Timestamp', 'Payer', 'Amount (ISK)', 'Structure', 'Output']}
      numeric={['Amount (ISK)']}
      rows={12}
    />
  </LoadingShell>
)
export default RevenueLoading
