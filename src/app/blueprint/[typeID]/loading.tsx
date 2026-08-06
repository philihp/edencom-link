import { LoadingShell, SkeletonLines } from '../../skeleton'

// The heading is the blueprint's product name, resolved from the SDE mirror.
const BlueprintLoading = () => (
  <LoadingShell>
    <SkeletonLines count={6} />
  </LoadingShell>
)
export default BlueprintLoading
