// Mirrors CCP's SDE + dogma data in the exact protobuf shape @eveshipfit/react
// expects (types/groups/marketGroups/typeDogma/dogmaEffects/dogmaAttributes)
// into public/esf-data/, committed to the repo, so EveDataProvider can load it
// same-origin in the browser. The upstream data.eveship.fit host both is
// CORS-locked to eveship.fit itself ("to control cost" per its README) and,
// in practice, 403s plain server-side fetches from Vercel's build network
// (likely datacenter-IP bot-blocking) — so unlike src/buildSde.js's Fuzzwork
// mirror, this can NOT run as a predev/prebuild step; it must be run by hand
// (from a network eveship.fit doesn't block) and its output committed.
// Re-run `pnpm run esf:build -- --force` to refresh after bumping
// @eveshipfit/data, and commit the resulting public/esf-data/ changes.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESF_DATA_VERSION } from '@eveshipfit/data'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, '..', 'public', 'esf-data')

const BASE_URL = `https://data.eveship.fit/v${ESF_DATA_VERSION}/sde/`

// The exact file set @eveshipfit/react's EveDataProvider fetches, one .pb2
// (protobuf) file each — see its bundled EveDataProvider implementation.
const FILES = ['types', 'groups', 'marketGroups', 'typeDogma', 'dogmaEffects', 'dogmaAttributes']

const downloadFile = async (name) => {
  const url = `${BASE_URL}${name}.pb2`
  console.log(`esf: downloading ${name}.pb2…`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await writeFile(join(OUTPUT_DIR, `${name}.pb2`), bytes)
  console.log(`esf: wrote ${name}.pb2 (${bytes.length} bytes)`)
}

const run = async () => {
  const force = process.argv.includes('--force')
  await mkdir(OUTPUT_DIR, { recursive: true })

  for (const name of FILES) {
    const path = join(OUTPUT_DIR, `${name}.pb2`)
    if (!force) {
      const exists = await access(path).then(
        () => true,
        () => false
      )
      if (exists) {
        console.log(`esf: ${path} already exists, skipping (pass --force to regenerate)`)
        continue
      }
    }
    await downloadFile(name)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
