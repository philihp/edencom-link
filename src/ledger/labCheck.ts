// The ledger-check rules on the lab copy (ledger stage 1, protocol step 2;
// docs/ledger/stage-1.md). Reads the lab with psql (host checked first, guard
// C8), then for each wallet:
//   - builds the chain from scratch, as the first production run will;
//   - builds it again as daily runs would, continuing from the stored last
//     segment in steps of `--steps` rows, and checks that the result is the
//     same (the incremental path must equal the full replay);
//   - counts the rows a first run and a daily run would write.
// Prints one line per wallet label and the totals: the budget for production.
//
//   pnpm run ledger-lab-check [-- --steps 500]
import { execFileSync } from 'node:child_process'

import { map, reduce, splitEvery } from 'ramda'

import { type JournalRow, type Segment, chainOf } from './chain.ts'
import { nextChain, segmentWrites } from './check.ts'
import { assertLocal } from './labGuard.ts'

const LOCAL_STACK = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const url = assertLocal(process.env.LAB_DATABASE_URL ?? LOCAL_STACK, 'LAB_DATABASE_URL')
const args = process.argv.slice(2)
const stepsAt = args.indexOf('--steps')
const steps = stepsAt === -1 ? 500 : Number(args[stepsAt + 1])

const SQL = `
select wallet, entry_id, to_char(date at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), amount, balance from (
  select dense_rank() over (order by r.character_id)::text as wallet, j.entry_id, j.date, j.amount, j.balance
  from ledger_lab.character_wallet_journal j join ledger_lab.registration r on r.id = j.registration_id
  union all
  select 'corporation ' || dense_rank() over (order by corporation_id) || ' division ' || division, entry_id, date, amount, balance
  from ledger_lab.corp_wallet_journal
) w order by wallet, entry_id`

const started = Date.now()
const text = execFileSync('psql', [url, '-X', '-q', '-A', '-F', '\t', '-t', '-c', SQL], {
  encoding: 'utf8',
  maxBuffer: 1 << 30,
})
const byWallet = reduce(
  (acc: Map<string, JournalRow[]>, line: string) => {
    if (line === '') return acc
    const [wallet, entryId, date, amount, balance] = line.split('\t')
    const rows = acc.get(wallet) ?? []
    rows.push({ entryId: Number(entryId), date, amount: amount || null, balance: balance || null })
    return acc.set(wallet, rows)
  },
  new Map(),
  text.split('\n')
)
const readMs = Date.now() - started

type Line = {
  wallet: string
  rows: number
  segments: number
  rounding: number
  firstRunWrites: number
  dailyWrites: number
  same: boolean
}

const daily = (rows: JournalRow[]): { segments: Segment[]; writes: number[] } =>
  reduce(
    (acc: { segments: Segment[]; writes: number[] }, batch: JournalRow[]) => {
      const next = nextChain(acc.segments, batch, false)
      const { upsert, remove } = segmentWrites(acc.segments, next)
      acc.writes.push(upsert.length + remove.length + 1)
      return { segments: next.segments, writes: acc.writes }
    },
    { segments: [], writes: [] },
    splitEvery(steps, rows)
  )

const lines: Line[] = map(
  ([wallet, rows]) => {
    const full = chainOf(rows)
    const inSteps = daily(rows)
    const firstRun = segmentWrites([], full)
    return {
      wallet: /^\d+$/.test(wallet) ? `character #${wallet}` : wallet,
      rows: rows.length,
      segments: full.segments.length,
      rounding: reduce((n: number, s: Segment) => n + s.roundingSteps, 0, full.segments),
      firstRunWrites: firstRun.upsert.length + 1,
      dailyWrites: Math.max(...inSteps.writes.slice(1), 0),
      same:
        JSON.stringify(inSteps.segments, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ===
        JSON.stringify(full.segments, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    }
  },
  [...byWallet.entries()]
)

console.table(lines)
const total = (k: keyof Line) => reduce((n: number, l: Line) => n + Number(l[k]), 0, lines)
console.log(
  JSON.stringify({
    wallets: lines.length,
    rows: total('rows'),
    segments: total('segments'),
    roundingSteps: total('rounding'),
    firstRunWrites: total('firstRunWrites'),
    largestDailyWrites: Math.max(...map((l) => l.dailyWrites, lines)),
    incrementalEqualsFull: lines.every((l) => l.same),
    readMs,
    foldMs: Date.now() - started - readMs,
  })
)
