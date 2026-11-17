// The ledger lab runner (docs/ledger/lab.md).
//
//   pnpm run ledger-lab -- load [--dir lab/ledger-copy]   make the lab schema and load a copy
//   pnpm run ledger-lab -- census                         print the census report
//
// The database is LAB_DATABASE_URL, else the Supabase local stack's default
// (postgresql://postgres:postgres@127.0.0.1:54322/postgres). Each command
// first checks that the database is on this computer (guard C8 of
// docs/ledger/plan.md): the load drops and makes the schema `ledger_lab`,
// and the census reads whole tables. Neither may ever reach production.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { assertLocal } from './labGuard.ts'
import { loadScript } from './labSpec.ts'

const LOCAL_STACK = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const url = assertLocal(process.env.LAB_DATABASE_URL ?? LOCAL_STACK, 'LAB_DATABASE_URL')

const psql = (psqlArgs: string[], options: { input?: string } = {}) =>
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', ...psqlArgs], {
    input: options.input,
    stdio: [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    env: { ...process.env, PGOPTIONS: '-c search_path=ledger_lab' },
  })

const commands: Record<string, () => void> = {
  load: () => {
    psql(['-q', '-f', 'docs/ledger/lab/schema.sql'])
    psql(['-f', '-'], { input: loadScript(resolve(flag('--dir') ?? 'lab/ledger-copy')) })
  },
  census: () => {
    psql(['-f', 'docs/ledger/census.sql'])
  },
}

const command = commands[args[0] ?? '']
if (command === undefined) {
  console.error('usage: pnpm run ledger-lab -- load [--dir <copy>] | census')
  process.exit(1)
}
command()
