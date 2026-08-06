import { LoadingShell, SkeletonTable } from '../skeleton'
import { RACE_COLUMNS } from './shipMatrix'

// The library is a hull-class × race chart, and both axes are static — so the
// fallback can lay out the real grid and only the cells are placeholders.
const FittingLoading = () => (
  <LoadingShell title="Fittings">
    <SkeletonTable columns={['Class', ...RACE_COLUMNS]} rows={6} />
  </LoadingShell>
)
export default FittingLoading
