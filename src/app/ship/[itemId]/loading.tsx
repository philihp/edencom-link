import { LoadingShell, SkeletonLines, SkeletonTable } from '../../skeleton'

// A ship page is the fit wheel plus the module/cargo listing. The wheel already
// reserves its own space once the page renders (fitPlaceholder.tsx), so what
// this stands in for is everything before that: the ship's own row, its owner,
// and the contents query.
const ShipLoading = () => (
  <LoadingShell crumbs>
    <SkeletonLines count={3} />
    <SkeletonTable
      columns={['Quantity', 'Item', 'Volume (m³)', 'Group', 'Category', 'Owner', 'Hangar', 'Contents']}
      numeric={['Quantity', 'Volume (m³)', 'Contents']}
      rows={10}
    />
  </LoadingShell>
)
export default ShipLoading
