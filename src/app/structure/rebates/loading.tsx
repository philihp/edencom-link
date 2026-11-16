import { LoadingShell, SkeletonTable } from '../../skeleton'

const RebatesLoading = () => (
  <LoadingShell title="Tax Rebates">
    <SkeletonTable
      columns={['Payer', 'Type', 'Edencom', 'Jobs', 'Tax paid (ISK)', 'Rebated (ISK)', 'Pending (ISK)', 'Net (ISK)']}
      numeric={['Jobs', 'Tax paid (ISK)', 'Rebated (ISK)', 'Pending (ISK)', 'Net (ISK)']}
      rows={12}
    />
  </LoadingShell>
)
export default RebatesLoading
