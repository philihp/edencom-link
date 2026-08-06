import { LoadingShell, SkeletonTable } from '../../skeleton'

// The heading is the location's own name, which is one of the things being
// fetched — so it's a bar rather than text, and the breadcrumb line above it is
// reserved so the heading doesn't jump when the real crumbs arrive.
const AssetLocationLoading = () => (
  <LoadingShell crumbs>
    <SkeletonTable
      columns={['Quantity', 'Item', 'Volume (m³)', 'Group', 'Category', 'Owner', 'Hangar', 'Contents']}
      numeric={['Quantity', 'Volume (m³)', 'Contents']}
      rows={12}
    />
  </LoadingShell>
)
export default AssetLocationLoading
