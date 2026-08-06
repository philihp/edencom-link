import { LoadingShell, SkeletonTable } from '../../skeleton'

const AssetSearchLoading = () => (
  <LoadingShell title="Search Assets">
    <SkeletonTable
      columns={['Owner', 'System', 'Station', 'Item', 'Quantity', 'Hangar', 'Contents']}
      numeric={['Quantity', 'Contents']}
      rows={10}
    />
  </LoadingShell>
)
export default AssetSearchLoading
