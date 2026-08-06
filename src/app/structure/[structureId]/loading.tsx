import { LoadingShell, SkeletonLines } from '../../skeleton'

// The heading is the structure's own name, so it's a bar until it resolves.
const StructureDetailLoading = () => (
  <LoadingShell>
    <SkeletonLines count={8} />
  </LoadingShell>
)
export default StructureDetailLoading
