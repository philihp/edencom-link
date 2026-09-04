// Checks GitHub Packages for a newer release of the vendored
// @eveshipfit/dogma-engine and, when found, packs the new tarball into
// vendor/eveshipfit/ and rewrites the file: specifier in package.json. Run by
// .github/workflows/bump-eveshipfit.yml, which then regenerates the lockfile
// and opens a PR. See the "Vendored @eveshipfit/*" note in CLAUDE.md for the
// manual version of this flow.
//
// It used to track @eveshipfit/react and its @eveshipfit/data stub too; stage
// 4 of docs/custom-fit-ui.md replaced that package with our own viewer, so the
// WASM engine is all that is left to follow.
//
// npm auth for npm.pkg.github.com is expected via NPM_CONFIG_USERCONFIG
// pointing at a runner-temp .npmrc (kept out of the repo so no token is ever
// committed). Reads/writes files relative to the repo root; emits `changed`
// (and, when changed, a PR body file at PR_BODY_PATH) to $GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkgPath = join(repoRoot, 'package.json')
const vendorDir = join(repoRoot, 'vendor', 'eveshipfit')

// The one package we vendor: the Rust/WASM dogma engine, which *is* the
// calculation model. Everything around it is ours.
const PACKAGES = ['@eveshipfit/dogma-engine']

const npm = (args) => execFileSync('npm', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
// npm flattens the scope in the packed filename: @eveshipfit/dogma-engine -> eveshipfit-dogma-engine
const flatten = (name) => name.replace('@', '').replace('/', '-')
// "file:vendor/eveshipfit/eveshipfit-dogma-engine-7.1.0.tgz" -> "7.1.0"
const versionOf = (spec) => spec?.match(/-(\d[\w.-]*)\.tgz$/)?.[1] ?? null

const pkg = readJson(pkgPath)
const changes = []

for (const name of PACKAGES) {
  const current = versionOf(pkg.dependencies[name])
  const latest = npm(['view', name, 'version'])
  if (!latest) throw new Error(`could not resolve latest version of ${name}`)
  if (latest === current) {
    console.log(`${name}: up to date (${current})`)
    continue
  }
  console.log(`${name}: ${current} -> ${latest}`)

  // Pack the new release straight into the vendor dir, then drop the old one.
  const { filename } = JSON.parse(npm(['pack', `${name}@${latest}`, '--pack-destination', vendorDir, '--json']))[0]
  const prefix = `${flatten(name)}-`
  for (const f of readdirSync(vendorDir)) {
    if (f.startsWith(prefix) && f.endsWith('.tgz') && f !== filename) rmSync(join(vendorDir, f))
  }
  pkg.dependencies[name] = `file:vendor/eveshipfit/${filename}`
  changes.push({ name, from: current, to: latest })
}

const out = process.env.GITHUB_OUTPUT
if (!changes.length) {
  console.log('No @eveshipfit updates available.')
  if (out) appendFileSync(out, 'changed=false\n')
} else {
  writeJson(pkgPath, pkg)
  const list = changes.map((c) => `- \`${c.name}\`: ${c.from} → **${c.to}**`).join('\n')
  const body = `## Automated \`@eveshipfit\` vendor bump

${list}

The published tarball was re-packed into \`vendor/eveshipfit/\` and the \`file:\` specifier in \`package.json\` updated; the lockfile was regenerated. See the "Vendored @eveshipfit/*" note in \`CLAUDE.md\`.

⚠️ This package is the WASM fit engine, which Vercel Skew Protection breaks under Turbopack — verify the Vercel preview's \`/ship/[itemId]\` ring renders (with stats) before merging.

_Opened by \`.github/workflows/bump-eveshipfit.yml\`._
`
  if (process.env.PR_BODY_PATH) writeFileSync(process.env.PR_BODY_PATH, body)
  if (out) {
    appendFileSync(out, 'changed=true\n')
    appendFileSync(out, `title=Bump vendored @eveshipfit (${changes.map((c) => `${c.name.split('/').pop()}@${c.to}`).join(', ')})\n`)
  }
}
