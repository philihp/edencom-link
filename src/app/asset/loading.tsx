import { LoadingShell, SkeletonTable } from '../skeleton'

// Building the location buckets means two location-summary RPCs plus a name
// resolution pass, so this stands in from the moment the link is clicked.
const AssetsLoading = () => (
  <LoadingShell title="Assets">
    <SkeletonTable columns={['System', 'Location', 'Items']} numeric={['Items']} rows={10} />
  </LoadingShell>
)
export default AssetsLoading
