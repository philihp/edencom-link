import { LoadingShell, SkeletonLines, SkeletonTable } from '../skeleton'

// The page is a server-rendered SVG topology above the den table; the lines
// stand in for the map, which is drawn from the same query as the rows.
const MercenaryDensLoading = () => (
  <LoadingShell title="Mercenary Dens">
    <SkeletonLines count={4} />
    <SkeletonTable
      columns={[
        'System',
        'Planet',
        'Owner',
        'State',
        'Development',
        'Anarchy',
        'Infomorphs',
        'Reinforced',
        'Observed At',
      ]}
      rows={10}
    />
  </LoadingShell>
)
export default MercenaryDensLoading
