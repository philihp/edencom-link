// The ledger lab copy (docs/ledger/plan.md, stage 0 step 1; docs/ledger/lab.md).
//
//   pnpm run ledger-lab-copy -- --user <account uuid> --confirm [--out lab/ledger-copy] [--pause-ms 300] [--dry-run]
//                                [--tables a,b,c]
//
// --tables copies only the named tables. Each other table gets a file with the
// header line only, so that the load still runs; the manifest lists them under
// `skipped`.
//
// Reads the wallet, contract and industry job rows of ONE account from
// production, read-only, through PostgREST with the service key, and writes
// them as CSV files on this computer. It writes nothing to any database.
// `pnpm run ledger-lab -- load` then loads the files into a local Postgres.
//
// Load on production: one page of at most 1,000 rows at a time, each an index
// range scan (src/ledger/labSpec.ts), with a pause between pages. On the first
// error the copy stops. It does not retry: a slow or failing page is the stop
// condition of the plan, and a retry would add load to a database that is
// already in trouble.
//
// The owner must say OK before each run (plan section 8, decision 1). The
// --confirm flag is that OK written down; without it the copy refuses.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createClient } from '@supabase/supabase-js'
import { chain, last, map, pluck, reduce, toPairs, uniq } from 'ramda'

import { csvRows } from './labCsv.ts'
import {
  REGISTRATION_COLUMNS,
  TABLES,
  type Owners,
  type Partition,
  type TableSpec,
  csvColumnsOf,
  keysetAfter,
  labTableOf,
  partitionsOf,
  selectOf,
  valuesOf,
} from './labSpec.ts'

const PAGE = 1000

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const has = (name: string): boolean => args.includes(name)

const userId = flag('--user')
const outDir = flag('--out') ?? 'lab/ledger-copy'
const pauseMs = Number(flag('--pause-ms') ?? 300)
const dryRun = has('--dry-run')
const only = flag('--tables')?.split(',')
const wanted = (spec: TableSpec): boolean => only === undefined || only.includes(spec.table)

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (!userId) fail('--user <account uuid> is required')
if (!has('--confirm')) fail('refused: the owner must OK each copy from production; pass --confirm when they have')
const url = process.env.SUPABASE_URL ?? fail('SUPABASE_URL is not set')
const serviceKey = process.env.SUPABASE_SERVICE_KEY ?? fail('SUPABASE_SERVICE_KEY is not set')

const client = createClient(url, serviceKey, { auth: { persistSession: false } })

const stats = { pages: 0, slowestMs: 0 }

// One page, timed. Any error stops the copy.
const fetchPage = async (spec: TableSpec, partition: Partition, after: Record<string, unknown> | null) => {
  const filtered = reduce(
    (query: any, [column, value]: [string, string | number]) => query.eq(column, value),
    client.from(spec.table).select(selectOf(spec)),
    toPairs(partition)
  )
  const keyset = keysetAfter(spec.keys, after)
  const paged =
    keyset === null ? filtered : 'gt' in keyset ? filtered.gt(keyset.gt[0], keyset.gt[1]) : filtered.or(keyset.or)
  const ordered = reduce((query: any, key: string) => query.order(key, { ascending: true }), paged, spec.keys)
  const started = Date.now()
  const { data, error } = await ordered.limit(PAGE)
  const elapsed = Date.now() - started
  stats.pages += 1
  stats.slowestMs = Math.max(stats.slowestMs, elapsed)
  if (error) throw new Error(`${spec.table} ${JSON.stringify(partition)}: ${error.message} — copy stopped`)
  return data as Record<string, unknown>[]
}

// Tail-recursive keyset paging of one partition into `file`. → rows copied.
const copyPartition = async (
  spec: TableSpec,
  partition: Partition,
  file: string,
  after: Record<string, unknown> | null = null,
  copied = 0
): Promise<number> => {
  const rows = await fetchPage(spec, partition, after)
  appendFileSync(
    file,
    csvRows(
      csvColumnsOf(spec),
      map((row) => valuesOf(spec, row), rows)
    )
  )
  if (rows.length < PAGE) return copied + rows.length
  await sleep(pauseMs)
  return copyPartition(spec, partition, file, last(rows) ?? null, copied + rows.length)
}

// One partition, then the pause before the next one.
const copyThenPause = async (spec: TableSpec, partition: Partition, file: string): Promise<number> => {
  const copied = await copyPartition(spec, partition, file)
  await sleep(pauseMs)
  return copied
}

const copyTable = async (spec: TableSpec, owners: Owners): Promise<[string, number]> => {
  const file = join(outDir, `${labTableOf(spec)}.csv`)
  writeFileSync(file, `${csvColumnsOf(spec).join(',')}\n`)
  if (!wanted(spec)) return [spec.table, -1]
  const counts = await reduce(
    async (sum: Promise<number>, partition: Partition) => (await sum) + (await copyThenPause(spec, partition, file)),
    Promise.resolve(0),
    partitionsOf(spec, owners)
  )
  console.log(`${spec.table}: ${counts} rows`)
  return [spec.table, counts]
}

const main = async () => {
  const { data: registrations, error } = await client
    .from('registration')
    .select(REGISTRATION_COLUMNS.join(','))
    .eq('user_id', userId as string)
    .order('id')
  if (error) throw new Error(`registration: ${error.message}`)
  const rows = registrations as unknown as Record<string, unknown>[]
  if (rows.length === 0) fail(`no registration rows for account ${userId}`)
  const owners: Owners = {
    registrationIds: pluck('id', rows) as string[],
    corporationIds: uniq(chain((r) => (r.corporation_id === null ? [] : [Number(r.corporation_id)]), rows)),
  }
  console.log(
    `account: ${owners.registrationIds.length} characters, ${owners.corporationIds.length} corporations; ` +
      `${reduce((n, spec) => n + (wanted(spec) ? partitionsOf(spec, owners).length : 0), 0, TABLES)} partitions`
  )
  if (dryRun) return
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'registration.csv'),
    `${REGISTRATION_COLUMNS.join(',')}\n${csvRows(REGISTRATION_COLUMNS, rows)}`
  )
  const startedAt = new Date().toISOString()
  const counts = await reduce(
    async (acc: Promise<[string, number][]>, spec: TableSpec) => [...(await acc), await copyTable(spec, owners)],
    Promise.resolve([]),
    TABLES
  )
  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceHost: new URL(url).host,
        pauseMs,
        pages: stats.pages,
        slowestPageMs: stats.slowestMs,
        rows: Object.fromEntries(counts.filter(([, n]) => n >= 0)),
        skipped: counts.filter(([, n]) => n < 0).map(([table]) => table),
      },
      null,
      2
    )}\n`
  )
  console.log(`done: ${stats.pages} pages, slowest ${stats.slowestMs} ms; files in ${outDir}`)
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
