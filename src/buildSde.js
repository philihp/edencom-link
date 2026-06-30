// Generates src/generated/sdeTypes.json from CCP's Static Data Export so the
// app can resolve type names/groups/categories locally instead of depending on
// the remote sde.edencom.link service. Runs as a `predev`/`prebuild` step (see
// package.json) — re-run `npm run sde:build -- --force` to refresh the data.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'generated', 'sdeTypes.json')

// Fuzzwork republishes CCP's SDE as flat CSVs, refreshed shortly after each
// game patch — much smaller and faster to fetch than CCP's own multi-file zip.
const TYPES_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/invTypes.csv'
const GROUPS_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv'

// Minimal RFC 4180 CSV parser: invTypes' description column embeds raw commas
// and newlines inside quoted fields, so a naive line/comma split corrupts rows.
const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (c === '"') {
        inQuotes = false
      } else {
        field += c
      }
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') continue
    else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const BOM = String.fromCharCode(0xfeff)

const fetchRecords = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  const text = await res.text()
  const rows = parseCsv(text.startsWith(BOM) ? text.slice(1) : text)
  const [header, ...body] = rows
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

const run = async () => {
  const force = process.argv.includes('--force')
  if (!force) {
    const exists = await access(OUTPUT_PATH).then(
      () => true,
      () => false
    )
    if (exists) {
      console.log(`sde: ${OUTPUT_PATH} already exists, skipping (pass --force to regenerate)`)
      return
    }
  }

  console.log('sde: downloading invTypes/invGroups from the SDE…')
  const [types, groups] = await Promise.all([fetchRecords(TYPES_URL), fetchRecords(GROUPS_URL)])
  const categoryIDByGroup = new Map(groups.map((g) => [g.groupID, Number(g.categoryID)]))

  // [typeID, name, groupID, categoryID] tuples, published types only — this is
  // the same "curated" cut the old remote service exposed.
  const out = types
    .filter((t) => t.published === '1' && t.typeName.trim() !== '')
    .map((t) => [Number(t.typeID), t.typeName, Number(t.groupID), categoryIDByGroup.get(t.groupID) ?? null])
    .sort((a, b) => a[0] - b[0])

  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(out))
  console.log(`sde: wrote ${out.length} types to ${OUTPUT_PATH}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
