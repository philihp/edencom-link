import { LoadingShell, SkeletonTiles } from '../skeleton'

// Structures render as a card grid, not a table — each tile carrying a
// fuel and service state, and industry-index sparklines.
const StructuresLoading = () => (
  <LoadingShell title="Structures">
    <SkeletonTiles count={6} />
  </LoadingShell>
)
export default StructuresLoading
