import { LoadingShell, SkeletonTable } from '../skeleton'

const MarketLoading = () => (
  <LoadingShell title="Market">
    <SkeletonTable
      columns={['Seller', 'Type', 'Qty', 'Unit (ISK)', 'Total (ISK)', 'Sold', 'Seen']}
      numeric={['Qty', 'Unit (ISK)', 'Total (ISK)']}
      rows={12}
    />
  </LoadingShell>
)
export default MarketLoading
