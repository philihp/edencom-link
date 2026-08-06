import { LoadingShell, SkeletonTable } from '../skeleton'

const MarketLoading = () => (
  <LoadingShell title="Market">
    <SkeletonTable
      columns={['Seller', 'Type', 'Qty', 'Unit (kISK)', 'Total (kISK)', 'Sold', 'Seen']}
      numeric={['Qty', 'Unit (kISK)', 'Total (kISK)']}
      rows={12}
    />
  </LoadingShell>
)
export default MarketLoading
