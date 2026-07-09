// Mirrors CCP's SDE + dogma data in the exact protobuf shape @eveshipfit/react
// expects (types/groups/marketGroups/typeDogma/dogmaEffects/dogmaAttributes),
// into public/esf-data/ so EveDataProvider can load it same-origin in the
// browser. The upstream data.eveship.fit host is deliberately CORS-locked to
// eveship.fit itself ("to control cost" per its README), but that only blocks
// browser fetch() calls — a server-side download at build time, mirroring
// this one set of versioned files into our own static assets, is exactly the
// self-hosting path the library documents for embedders.
// Runs as a `predev`/`prebuild` step (see package.json) — re-run
// `pnpm run esf:build -- --force` to refresh after bumping @eveshipfit/data.
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
