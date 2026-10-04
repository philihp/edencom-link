// Vercel's "ignored build step" (vercel.json `ignoreCommand`): decide whether a
// push changed anything the deployment serves. Exit 0 tells Vercel to skip the
// build; exit 1 tells it to build. A docs-only push is skipped.
//
// The comparison is against VERCEL_GIT_PREVIOUS_SHA — the last successful
// deployment of this branch — not against HEAD^. A push can carry several
// commits, and only the last one is "HEAD^..HEAD"; a code commit followed by
// a docs commit would then look docs-only and lose its preview. Diffing from
// the previous deployment covers the whole push.
//
// Everything that cannot be decided errs toward building: no previous
// deployment (a new branch), a previous SHA the shallow clone no longer holds,
// a failed git call, or an empty diff (a redeploy).
//
// This runs BEFORE `pnpm install`, so it may import nothing from node_modules —
// no ramda, no ts-pattern. Node built-ins only.
//
//   VERCEL_GIT_PREVIOUS_SHA=<sha> node scripts/vercelIgnoreBuild.mjs
//
// The decision itself is the pure `decide()` below, tested in
// test/vercelIgnoreBuild.test.ts; this file's CLI tail only gathers its input.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Files under docs/ that the deployment serves. A change to one of these is an
// app change, not a docs change: next.config.mjs ships the skill file with
// /api/mcp (outputFileTracingIncludes) and get_skill reads it at request time.
export const SERVED_DOCS = ['docs/edencom-industry-SKILL.md']

// A path whose change needs no deployment.
export const isDocsOnly = (path) => path.startsWith('docs/') && !SERVED_DOCS.includes(path)

// The decision for a list of changed paths: skip only when every path is a
// docs-only path. The reason names what decided it, for the build log.
export const decide = (changed) => {
  if (changed.length === 0) return { skip: false, reason: 'no changed paths — building' }
  const served = changed.find((path) => !isDocsOnly(path))
  return served === undefined
    ? { skip: true, reason: `only docs/ changed (${changed.length} file${changed.length === 1 ? '' : 's'}) — skipping` }
    : { skip: false, reason: `${served} changed — building` }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const main = () => {
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA ?? ''
  if (base === '') {
    console.log('no previous deployment on this branch — building')
    return 1
  }
  try {
    git('cat-file', '-e', `${base}^{commit}`)
  } catch {
    console.log(`previous deployment ${base} is not in the clone — building`)
    return 1
  }
  let changed
  try {
    changed = git('diff', '--name-only', base, 'HEAD')
      .split('\n')
      .filter((line) => line !== '')
  } catch (error) {
    console.log(`git diff failed (${error instanceof Error ? error.message : error}) — building`)
    return 1
  }
  const { skip, reason } = decide(changed)
  console.log(`since ${base.slice(0, 7)}: ${reason}`)
  return skip ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
