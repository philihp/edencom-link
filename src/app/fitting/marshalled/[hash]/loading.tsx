import { LoadingShell, SkeletonLines } from '../../../skeleton'

// One marshalled fit in the viewer; same shape as a saved fit's page.
const MarshalledFittingLoading = () => (
  <LoadingShell>
    <SkeletonLines count={6} />
  </LoadingShell>
)
export default MarshalledFittingLoading
