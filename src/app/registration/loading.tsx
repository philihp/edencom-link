import { LoadingShell, SkeletonLines } from '../skeleton'

// The matrix's width depends on how many characters the caller has and, from
// phase 3, how many job columns their grants earn — so bars rather than a
// skeleton table with invented columns (same call /jobs makes).
const RegistrationLoading = () => (
  <LoadingShell title="Registrations & refresh">
    <SkeletonLines count={6} />
  </LoadingShell>
)
export default RegistrationLoading
