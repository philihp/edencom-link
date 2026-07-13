// Checks GitHub Packages for newer releases of the vendored @eveshipfit
// packages and, when found, packs the new tarball into vendor/eveshipfit/,
// rewrites the file: specifier in package.json, and (if react's @eveshipfit/data
// peer major changed) bumps the local data stub to a version that still
// satisfies it. Run by .github/workflows/bump-eveshipfit.yml, which then
// regenerates the lockfile and opens a PR. See the "Vendored @eveshipfit/*
// packages" note in CLAUDE.md for the manual version of this flow.
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
const stubDir = join(vendorDir, 'data-stub')

// The two packages we actually vendor. @eveshipfit/data is intentionally not
// here — it's a local stub (see below), not a tracked upstream release.
const PACKAGES = ['@eveshipfit/react', '@eveshipfit/dogma-engine']

const npm = (args) => execFileSync('npm', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
// npm flattens the scope in the packed filename: @eveshipfit/react -> eveshipfit-react
const flatten = (name) => name.replace('@', '').replace('/', '-')
// "file:vendor/eveshipfit/eveshipfit-react-4.7.2.tgz" -> "4.7.2"
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

// react imports one constant (ESF_DATA_VERSION) from @eveshipfit/data and
// declares it as a `^N` peer. Our stub stands in for it (data URL is overridden
// anyway). Only touch the stub when react moves to a new peer major — otherwise
// data's ~monthly releases would churn the stub for no reason.
const reactChange = changes.find((c) => c.name === '@eveshipfit/react')
if (reactChange) {
  const peers = JSON.parse(npm(['view', `@eveshipfit/react@${reactChange.to}`, 'peerDependencies', '--json']) || '{}')
  const wantMajor = peers['@eveshipfit/data']?.match(/\d+/)?.[0]
  const stubPkgPath = join(stubDir, 'package.json')
  const stubPkg = readJson(stubPkgPath)
  const haveMajor = stubPkg.version.match(/^\d+/)?.[0]
  if (wantMajor && wantMajor !== haveMajor) {
    // Use @eveshipfit/data's real latest version — it's guaranteed to satisfy
    // react's peer range and keeps the (inert) ESF_DATA_VERSION honest.
    const dataLatest = npm(['view', '@eveshipfit/data', 'version'])
    stubPkg.version = dataLatest
    writeJson(stubPkgPath, stubPkg)
    for (const f of ['index.mjs', 'index.cjs']) {
      const p = join(stubDir, f)
      writeFileSync(p, readFileSync(p, 'utf8').replace(/ESF_DATA_VERSION = '[^']*'/, `ESF_DATA_VERSION = '${dataLatest}'`))
    }
    changes.push({ name: '@eveshipfit/data (stub)', from: `${haveMajor}.x`, to: dataLatest })
    console.log(`data stub: bumped to ${dataLatest} to satisfy react's ^${wantMajor} peer`)
  }
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

The published tarball(s) were re-packed into \`vendor/eveshipfit/\` and the \`file:\` specifiers in \`package.json\` updated; the lockfile was regenerated. See the "Vendored @eveshipfit/* packages" note in \`CLAUDE.md\`.

⚠️ These packages ship a WASM fit engine that Vercel Skew Protection breaks under Turbopack — verify the Vercel preview's \`/ship/[itemId]\` wheel renders (with stats) before merging.

_Opened by \`.github/workflows/bump-eveshipfit.yml\`._
`
  if (process.env.PR_BODY_PATH) writeFileSync(process.env.PR_BODY_PATH, body)
  if (out) {
    appendFileSync(out, 'changed=true\n')
    appendFileSync(out, `title=Bump vendored @eveshipfit packages (${changes.map((c) => `${c.name.split('/').pop()}@${c.to}`).join(', ')})\n`)
  }
}
