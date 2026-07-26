// Guards the one thing about supabase/migrations that can't be fixed after the
// fact: a PR that adds a migration numbered at or before one that has already
// merged. The Supabase CLI identifies a migration by its version (the 14-digit
// filename prefix), so a back-dated file lands in a different order in each
// environment — and "fixing" it by renaming the file afterwards only relocates
// the mismatch, since the migration history table matches by filename, not
// content. See the Workflow section of CLAUDE.md for the incident this exists
// to prevent.
//
// Two rules:
//   1. every migration the PR adds must sort strictly after every migration
//      already merged to the base branch (and must not reuse its version).
//   2. no migration file the PR started from may be renamed or deleted — the
//      filename is its identity to every database that already applied it.
//
// Run by .github/workflows/migration-order.yml on pull requests; also runnable
// locally as `node .github/scripts/check-migrations.mjs [base-ref]` (base-ref
// defaults to $BASE_REF, then origin/main).

import { execFileSync } from 'node:child_process'

import {
  ascend,
  chain,
  difference,
  endsWith,
  filter,
  forEach,
  groupBy,
  identity,
  isEmpty,
  join,
  keys,
  last,
  map,
  pipe,
  replace,
  sort,
  split,
  toPairs,
  uniq,
} from 'ramda'

export const MIGRATION_DIR = 'supabase/migrations'

// Supabase names migrations <14-digit UTC timestamp>_<name>.sql; `db:new`
// generates exactly this, and the CLI's version parser expects it.
const MIGRATION_NAME = /^(\d{14})_.*\.sql$/

const versionOf = (file) => file.match(MIGRATION_NAME)?.[1] ?? null

const ascending = sort(ascend(identity))
const normalize = pipe(uniq, ascending)

// version -> the file(s) carrying it, skipping anything unparseable. Ties exist
// on main already (two PRs merging with the same timestamp); they're harmless
// in hindsight, so they're named when something new collides with them but
// never enforced against retroactively.
const byVersion = pipe(filter(versionOf), groupBy(versionOf))

const latestVersion = pipe(keys, ascending, last)

/**
 * Pure comparison seam. Takes migration filenames (basenames, no directory) as
 * three sets and returns a list of human-readable problems; an empty list means
 * the PR is fine.
 *
 * - baseFiles: what has already merged to the base branch (its current tip)
 * - headFiles: what the PR's head has
 * - forkFiles: what the branch forked from, defaulting to baseFiles. Only the
 *   rename/delete rule uses it, so that a branch which simply hasn't been
 *   rebased doesn't read as having deleted whatever merged in the meantime.
 */
export const checkMigrations = ({ baseFiles, headFiles, forkFiles = baseFiles }) => {
  const base = normalize(baseFiles)
  const head = normalize(headFiles)
  const fork = normalize(forkFiles)

  const merged = byVersion(base)
  const latest = latestVersion(merged) ?? null
  const added = difference(head, fork)

  // Rule 2 first: a rename shows up as both a removal and an addition, and
  // naming the removal is the more useful half of that diagnosis.
  const removals = map(
    (file) =>
      `${file} was renamed or deleted, but it already exists on the base branch. A migration's ` +
      `filename is its identity to every database that has already applied it — restore the ` +
      `file and add a new migration instead.`,
    difference(fork, head)
  )

  const misnumbered = chain((file) => {
    const version = versionOf(file)
    if (!version)
      return [
        `${file} is not named <14-digit timestamp>_<name>.sql, so the Supabase CLI can't derive a ` +
          `version from it. Use \`pnpm run db:new <name>\` to scaffold migrations.`,
      ]
    if (merged[version])
      return [
        `${file} reuses version ${version}, already taken by ${join(', ', merged[version])} on the ` +
          `base branch. Renumber it above ${latest}.`,
      ]
    if (latest && version <= latest)
      return [
        `${file} is numbered ${version}, at or before the latest migration already merged ` +
          `(${join(', ', merged[latest])}). Renumber it above ${latest} — it hasn't been applied ` +
          `anywhere yet, so renaming your own new file is safe.`,
      ]
    return []
  }, added)

  // Two migrations added by the same PR can't share a version either: the CLI
  // would see one version for two files, whichever order they merge in.
  const twins = pipe(
    byVersion,
    toPairs,
    filter(([, files]) => files.length > 1),
    map(([version, files]) => `${join(' and ', files)} are added by this PR with version ${version}.`)
  )(added)

  return [...removals, ...misnumbered, ...twins]
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const migrationsAt = pipe(
  (ref) => git('ls-tree', '-r', '--name-only', ref, '--', MIGRATION_DIR),
  split('\n'),
  filter(endsWith('.sql')),
  map(replace(`${MIGRATION_DIR}/`, ''))
)

const main = () => {
  const baseRef = process.argv[2] ?? process.env.BASE_REF ?? 'origin/main'
  // Ordering is judged against the base branch as it stands now — a migration
  // that sorts before one already applied to production is a problem whether it
  // merged before or after this branch forked. The fork point is only used to
  // tell "this PR deleted a migration" apart from "this PR is behind main".
  const forkPoint = git('merge-base', baseRef, 'HEAD').trim()

  const errors = checkMigrations({
    baseFiles: migrationsAt(baseRef),
    headFiles: migrationsAt('HEAD'),
    forkFiles: migrationsAt(forkPoint),
  })

  if (isEmpty(errors)) {
    console.log(`No migration problems against ${baseRef}.`)
    return
  }

  forEach((error) => {
    // GitHub Actions renders ::error as an annotation on the run.
    console.log(`::error::${error}`)
    console.error(`✗ ${error}`)
  }, errors)
  process.exitCode = 1
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
