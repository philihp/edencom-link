import { LoadingShell, SkeletonLines } from '../skeleton'

// Four tables whose widths depend on how many characters and corps the caller
// has, so bars rather than a skeleton table with invented columns.
const JobsLoading = () => (
  <LoadingShell title="Extract jobs">
    <SkeletonLines count={8} />
  </LoadingShell>
)
export default JobsLoading
