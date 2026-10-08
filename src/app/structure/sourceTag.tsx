import { match } from 'ts-pattern'

import styles from './structures.module.css'

// Where a figure comes from, said in brackets beside it
// (docs/design-system/Structures.dc.html): an ESI scan by a director, the
// corp wallet journal, the EIV arithmetic, or the public structure directory.
// The tag names the source and nothing else — the number beside it is exactly
// what the page always showed.
export type Source = 'live' | 'ledger' | 'estimate' | 'directory'

const classOf = (source: Source): string =>
  match(source)
    .with('live', () => styles.tagLive)
    .with('ledger', () => styles.tagLedger)
    .with('estimate', () => styles.tagEstimate)
    .with('directory', () => styles.tagDirectory)
    .exhaustive()

export const SourceTag = ({ source }: { source: Source }) => (
  <span className={`${styles.tag} ${classOf(source)}`}>[ {source} ]</span>
)
