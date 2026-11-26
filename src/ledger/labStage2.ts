// The ledger stage 2 lab (docs/ledger/stage-2.md, protocol step 2;
// docs/ledger/lab.md "Stage 2").
//
//   pnpm run ledger-lab-stage2 -- setup [--dir lab/ledger-copy]   make the lab database and load a copy
//   pnpm run ledger-lab-stage2 -- measure                         print the stage 2 measurements
//
// Stage 2 adds a view and two functions that read the journals through their
// production indexes and RLS. To measure them as they will run, the lab needs
// the production shape: the journal tables with their indexes and policies,
// the stage 1 tables, and the stage 2 migration itself. So this lab is its own
// database (LAB_STAGE2_DATABASE_URL, else `ledger_stage2` on the Supabase
// local stack), not the schema `ledger_lab` of stage 0.
//
// `setup` DROPS the schema `public` of that database and makes it again. So
// the database must be on this computer (guard C8) and its name must start
// with `ledger_`: it can never be an app database.
//
// The source table definitions are not copied here by hand: they are cut
// from schema.sql (each `create table`, `create index`, row level security,
// policy and grant statement of the table), so the lab has the production
// indexes and policies of the day. The copy's rows go in with `\copy`. The
// lab account is one user that owns every registration of the copy.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { chain, filter, join, map, test, trim } from 'ramda'

import { assertLocal } from './labGuard.ts'
import { loadScript } from './labSpec.ts'

const LOCAL_STAGE2 = 'postgresql://postgres:postgres@127.0.0.1:54322/ledger_stage2'

// The user id of the lab account (the owner of every copied registration).
export const LAB_USER = '00000000-0000-0000-0000-00000000000a'

// The production tables the stage 2 objects read, cut from schema.sql.
export const SOURCE_SHAPES = ['character_wallet_journal', 'corp_wallet_journal', 'corp_job_access'] as const

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

// The statements of schema.sql that make one table: its create, indexes,
// row level security, policies and grants. Pure, for the test.
const startsWithFor = (table: string) =>
  test(
    new RegExp(
      `^(create table public\\.${table} \\(|create (unique )?index \\S+\\s+on public\\.${table}\\b|alter table public\\.${table} enable row level security$|create policy [^;]*\\bon public\\.${table}\\b|grant \\w+ +on public\\.${table}\\b)`,
      's'
    )
  )

const withoutComments = (statement: string): string =>
  trim(
    statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
  )

export const shapeOf = (schemaSql: string, table: string): string[] =>
  map((s: string) => `${s};`, filter(startsWithFor(table), map(withoutComments, schemaSql.split(/;[ \t]*\n/))))

const databaseName = (url: string): string => new URL(url).pathname.replace(/^\//, '')

// The lab database: on this computer (guard C8), and named ledger_…
export const stage2Url = (raw: string | undefined): string => {
  const url = assertLocal(raw ?? LOCAL_STAGE2, 'LAB_STAGE2_DATABASE_URL')
  if (!databaseName(url).startsWith('ledger_'))
    throw new Error('refused: the stage 2 lab drops its schema public, so its database name must start with ledger_')
  return url
}

const maintenanceOf = (url: string): string => {
  const u = new URL(url)
  u.pathname = '/postgres'
  return u.toString()
}

const psql = (target: string, psqlArgs: string[], input?: string) =>
  execFileSync('psql', [target, '-X', '-v', 'ON_ERROR_STOP=1', ...psqlArgs], {
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  })

const setupSql = (dir: string): string => {
  const schemaSql = readFileSync('schema.sql', 'utf8')
  const shapes = chain((table) => shapeOf(schemaSql, table), [...SOURCE_SHAPES])
  const csv = (name: string) => `'${resolve(dir, `${name}.csv`).replace(/'/g, "''")}'`
  return join('\n', [
    '\\set ON_ERROR_STOP 1',
    'drop schema if exists public cascade;',
    'create schema public;',
    'do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;',
    'do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;',
    'do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;',
    'grant usage on schema public to anon, authenticated, service_role;',
    'create schema if not exists auth;',
    "create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('lab.uid', true), '')::uuid $$;",
    'grant usage on schema auth to anon, authenticated;',
    // registration and my_corporation_ids() as the stage 1 SQL test has them:
    // the columns and the policy the ledger reads.
    'create table public.registration (id uuid primary key, user_id uuid not null, character_id bigint, corporation_id bigint, is_main boolean);',
    'create index character_user_id_idx on public.registration (user_id);',
    'alter table public.registration enable row level security;',
    `create policy "Users manage own characters" on public.registration for all to authenticated using (user_id = (select auth.uid()));`,
    'grant select on public.registration to authenticated;',
    'create or replace function public.my_corporation_ids() returns setof bigint language sql stable as $$ select r.corporation_id from public.registration r where r.user_id = (select auth.uid()) and r.corporation_id is not null $$;',
    'grant execute on function public.my_corporation_ids() to authenticated;',
    ...shapes,
    '\\i supabase/migrations/20261119091512_ledger_check.sql',
    '\\i supabase/migrations/20261120104657_ledger_hidden_credits.sql',
    '\\i supabase/migrations/20261126210114_ledger_cash.sql',
    // The copy, as stage 0 loads it, then into the production shapes.
    '\\i docs/ledger/lab/schema.sql',
    loadScript(resolve(dir)),
    `insert into public.registration select id, '${LAB_USER}', character_id, corporation_id, is_main from ledger_lab.registration;`,
    `\\copy public.character_wallet_journal (registration_id, entry_id, date, ref_type, amount, balance, first_party_id, second_party_id, context_id, context_id_type, tax, tax_receiver_id, seen_at) from ${csv('character_wallet_journal')} with (format csv, header true)`,
    `\\copy public.corp_wallet_journal (corporation_id, division, entry_id, date, ref_type, amount, balance, first_party_id, second_party_id, context_id, context_id_type, tax, tax_receiver_id, seen_at) from ${csv('corp_wallet_journal')} with (format csv, header true)`,
    `\\copy public.corp_job_access (registration_id, corporation_id, job, observed_at) from ${csv('corp_job_access')} with (format csv, header true)`,
    `insert into public.ledger_wallet_segment (id, registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count, rounding_steps, hidden_credit_steps, pending_credits, computed_at)
       overriding system value
       select id, registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count, rounding_steps, hidden_credit_steps,
              array(select jsonb_array_elements_text(pending_credits)::numeric(20, 2)), computed_at
       from ledger_lab.ledger_wallet_segment;`,
    `insert into public.ledger_check (id, registration_id, corporation_id, division, checked_at, ok, segments, new_breaks, rounding_steps, hidden_credit_steps, rows_read, rebuilt, newest_entry_id, newest_entry_date, last_pull_at, snapshot_compare, snapshot_difference, reasons)
       overriding system value
       select id, registration_id, corporation_id, division, checked_at, ok, segments, new_breaks, rounding_steps, hidden_credit_steps, rows_read, rebuilt, newest_entry_id, newest_entry_date, last_pull_at, snapshot_compare, snapshot_difference,
              array(select jsonb_array_elements_text(reasons))
       from ledger_lab.ledger_check;`,
    'analyze;',
    '',
  ])
}

const commands: Record<string, (url: string) => void> = {
  setup: (url) => {
    const maintenanceUrl = maintenanceOf(url)
    const exists = execFileSync(
      'psql',
      [maintenanceUrl, '-X', '-At', '-c', `select 1 from pg_database where datname = '${databaseName(url)}'`],
      {
        encoding: 'utf8',
      }
    )
    if (exists.trim() !== '1') psql(maintenanceUrl, ['-q', '-c', `create database ${databaseName(url)}`])
    psql(url, ['-q', '-f', '-'], setupSql(flag('--dir') ?? 'lab/ledger-copy'))
  },
  measure: (url) => {
    psql(url, ['-v', `lab_uid=${LAB_USER}`, '-f', 'docs/ledger/lab/stage-2-measure.sql'])
  },
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const command = commands[args[0] ?? '']
  if (command === undefined) {
    console.error('usage: pnpm run ledger-lab-stage2 -- setup [--dir <copy>] | measure')
    process.exit(1)
  }
  command(stage2Url(process.env.LAB_STAGE2_DATABASE_URL))
}
