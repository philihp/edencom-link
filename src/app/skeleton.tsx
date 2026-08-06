import { map, times } from 'ramda'

import retro from './retro.module.css'
import styles from './skeleton.module.css'

// The building blocks each route's `loading.tsx` composes into a fallback.
//
// A `loading.tsx` renders the instant a navigation into its segment starts,
// before the server has done any work, so nothing here can know a single real
// value — the point is only to hold the page's shape (heading, table, the
// right number of columns) so the click feels answered and the layout doesn't
// jump when the real content lands.

// Cell widths cycle through a fixed list rather than being random: the
// fallback renders on the server too, and a random width would differ between
// that render and hydration.
const WIDTHS = ['72%', '48%', '86%', '55%', '64%', '40%', '78%', '58%']

// One shimmering bar. Decorative by definition — the surrounding <Loading…>
// wrapper is what announces the state — so it's hidden from assistive tech.
export const Skeleton = ({ width, heading }: { width?: string; heading?: boolean }) => (
  <span
    className={heading ? `${styles.block} ${styles.heading}` : styles.block}
    style={width ? { width } : undefined}
    aria-hidden="true"
  />
)

// A table with the real column headers (they're static, so showing them costs
// nothing and makes the fallback recognizably *this* page) over placeholder
// rows. `numeric` names the columns that render right-aligned in the real
// table, so the shimmer sits where the digits will.
export const SkeletonTable = ({
  columns,
  rows = 8,
  numeric = [],
}: {
  columns: string[]
  rows?: number
  numeric?: string[]
}) => (
  <table className={retro.retro}>
    <thead>
      <tr>
        {map(
          (column) => (
            <th key={column} className={numeric.includes(column) ? retro.num : undefined}>
              {column}
            </th>
          ),
          columns
        )}
      </tr>
    </thead>
    <tbody>
      {times(
        (row) => (
          <tr key={`row-${row}`}>
            {map(
              (column) => (
                <td key={column} className={numeric.includes(column) ? retro.num : undefined}>
                  <Skeleton width={WIDTHS[(row * columns.length + columns.indexOf(column)) % WIDTHS.length]} />
                </td>
              ),
              columns
            )}
          </tr>
        ),
        rows
      )}
    </tbody>
  </table>
)

// For the pages whose body isn't a table (a fit viewer, a chart, prose): a
// stack of bars of varying width, roughly where the text will be.
export const SkeletonLines = ({ count = 4 }: { count?: number }) => (
  <div className={styles.lines}>
    {times(
      (line) => (
        <Skeleton key={`line-${line}`} width={WIDTHS[line % WIDTHS.length]} />
      ),
      count
    )}
  </div>
)

// The structures page lays its content out as a card grid rather than a table,
// so its fallback does too.
export const SkeletonTiles = ({ count = 6 }: { count?: number }) => (
  <ul className={styles.tiles}>
    {times(
      (tile) => (
        <li key={`tile-${tile}`} className={styles.tile}>
          <Skeleton width="60%" heading />
          <Skeleton width={WIDTHS[tile % WIDTHS.length]} />
          <Skeleton width={WIDTHS[(tile + 3) % WIDTHS.length]} />
        </li>
      ),
      count
    )}
  </ul>
)

// The whole-page wrapper: a heading (its text when the route knows it
// statically, a bar when the heading is the very thing being fetched) and
// whatever the caller puts below it.
export const LoadingShell = ({
  title,
  crumbs = false,
  children,
}: {
  title?: string
  // Reserve the breadcrumb line for routes that render one, so the heading
  // doesn't jump up the page when the real crumbs arrive.
  crumbs?: boolean
  children?: React.ReactNode
}) => (
  <section aria-busy="true">
    <span className={styles.srOnly} role="status">
      Loading…
    </span>
    {crumbs ? (
      <p className={styles.crumbs}>
        <Skeleton width="24ch" />
      </p>
    ) : null}
    <div className={styles.header}>
      <h1>{title ?? <Skeleton width="18ch" heading />}</h1>
    </div>
    {children}
  </section>
)
