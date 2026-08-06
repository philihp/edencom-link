import { LoadingShell, SkeletonLines } from '../../skeleton'

// The freshness matrix is one column per job, so its width depends on data;
// bars rather than a table with invented columns.
const RefreshLoading = () => (
  <LoadingShell title="Refresh ESI">
    <SkeletonLines count={8} />
  </LoadingShell>
)
export default RefreshLoading
