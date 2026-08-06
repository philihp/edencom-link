import { LoadingShell, SkeletonTable } from '../skeleton'

const IndustryLoading = () => (
  <LoadingShell title="Industry">
    <SkeletonTable
      columns={['Owner', 'Activity', 'Product', 'Runs', 'Station', 'Start', 'End', 'Remaining']}
      numeric={['Runs']}
      rows={10}
    />
  </LoadingShell>
)
export default IndustryLoading
