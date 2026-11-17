// Guard C1 of docs/ledger/plan.md: the ledger never writes to a source table.
//
// The five wallet tables hold history that ESI no longer serves (it keeps 30
// days). A ledger bug that changed or deleted one of those rows could not be
// undone. So no ledger file may name a source table in a write: SQL `insert`,
// `update`, `delete`, `alter`, `drop` or `truncate`, or a supabase-js
// `.from('<source>')` chain that calls `insert`, `upsert`, `update` or
// `delete`. Reads are fine.
//
// The ledger lab (docs/ledger/lab/) makes its own copies of these tables in
// the schema `ledger_lab`; a name qualified with `ledger_lab.` is not a source.
// test/ is not scanned: a SQL test writes to stand-ins it makes and rolls back.
//
// Run by .github/workflows/test.yml; also `node .github/scripts/check-ledger-sources.mjs`.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { chain, filter, forEach, isEmpty, join, map, pipe, split, test } from 'ramda'

export const SOURCE_TABLES = [
  'character_wallet_journal',
  'corp_wallet_journal',
  'character_wallet_transaction',
  'corp_wallet_transaction',
  'character_wallet',
]

// The files that are ledger code: by directory, or by `ledger` in the name.
export const isLedgerFile = test(
  /^(src\/ledger\/|src\/app\/ledger\/|docs\/ledger\/.*\.sql$|src\/(jobs|workflows)\/ledger[^/]*$|supabase\/migrations\/[^/]*ledger[^/]*\.sql$|src\/app\/api\/cron\/ledger[^/]*\/)/
)

const TABLE = `(?:public\\.)?(?<table>${join('|', SOURCE_TABLES)})\\b`

// `\b` after the name keeps character_wallet from matching the start of
// character_wallet_journal. A name qualified with `ledger_lab.` never
// matches, because the table name must follow the verb at once.
const SQL_WRITE = new RegExp(
  `\\b(insert\\s+into|update|delete\\s+from|alter\\s+table(?:\\s+if\\s+exists)?(?:\\s+only)?|drop\\s+table(?:\\s+if\\s+exists)?|truncate(?:\\s+table)?(?:\\s+only)?)\\s+${TABLE}`,
  'gi'
)

// .from('character_wallet_journal') … .upsert( — within one call chain. The
// code has no semicolons (prettier), so a chain ends at a blank line, a `;`,
// or 400 characters.
const JS_WRITE = new RegExp(
  `\\.from\\(\\s*['"\`]${TABLE}['"\`]\\s*\\)(?:(?!\\n\\s*\\n)[^;]){0,400}?\\.(insert|upsert|update|delete)\\s*\\(`,
  'g'
)

const lineOf = (text, index) => text.slice(0, index).split('\n').length

// → problems in one file's text, as strings.
export const writesToSources = (path, text) =>
  map(
    (match) =>
      `${path}:${lineOf(text, match.index)} writes to the source table ${match.groups.table}: "${match[0].replace(/\s+/g, ' ').slice(0, 80)}"`,
    [...text.matchAll(SQL_WRITE), ...text.matchAll(JS_WRITE)]
  )

const trackedFiles = pipe(
  () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }),
  split('\n'),
  filter(isLedgerFile)
)

const main = () => {
  const problems = chain((path) => writesToSources(path, readFileSync(path, 'utf8')), trackedFiles())
  if (isEmpty(problems)) {
    console.log('No ledger file writes to a source table.')
    return
  }
  forEach((problem) => {
    console.log(`::error::${problem}`)
    console.error(`✗ ${problem}`)
  }, problems)
  process.exitCode = 1
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
