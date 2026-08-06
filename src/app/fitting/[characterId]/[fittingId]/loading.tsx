import { LoadingShell, SkeletonLines } from '../../../skeleton'

// One fit in the eveship.fit wheel; the heading is the fit's own name.
const FittingDetailLoading = () => (
  <LoadingShell>
    <SkeletonLines count={6} />
  </LoadingShell>
)
export default FittingDetailLoading
