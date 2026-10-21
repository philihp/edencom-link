// Which matrix columns /account/registrations draws. A column flagged
// `changes` is a grant that lets this site change something in game (save or
// delete fittings, send mail) rather than only read it; those are hidden unless
// the viewer turned on "Show grants that change things"
// (registrationsShowChanges.ts). The page runs both lists through here before
// anything counts or draws them, so `--cols`, the template row's "n of m" and
// every row follow. No I/O (test/changeColumns.test.ts).
import { reject } from 'ramda'

type Flagged = { changes?: boolean }

const visible = <T extends Flagged>(columns: readonly T[], showChanges: boolean): T[] =>
  showChanges ? [...columns] : reject((column: T) => column.changes === true, [...columns])

export const visibleJobColumns = <T extends Flagged>(entries: readonly T[], showChanges: boolean): T[] =>
  visible(entries, showChanges)

export const visibleGrantColumns = <T extends Flagged>(columns: readonly T[], showChanges: boolean): T[] =>
  visible(columns, showChanges)
