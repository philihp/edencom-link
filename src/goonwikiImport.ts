// `pnpm run goonwiki-import` — load the cleared Goon wiki pages into
// goonwiki_page, for the admin-only MCP tools search_wiki and read_wiki_page
// (docs/goonwiki-lookup.md). Run by the owner on aristotle:
//
//   pnpm run goonwiki-import -- ~/work/goonwiki-rewrite [--dry-run] [--allow-mass-delete]
//
// The argument is the cleared folder, or its `pages/` folder (a folder that
// holds `pages/` is read through it). A page is a `.md` file in a section
// folder (`geography/c-lp3n.md`) with the rewrite's front matter; files at the
// top (index.md, review.md, redirects.csv) are skipped. A section file without
// that front matter, or one that is not Markdown, refuses the whole run, so a
// stray uncleared file never loads. NEVER point this at the raw MediaWiki
// export: that content is not cleared.
//
// Idempotent: a page whose title and body are unchanged is not written, a
// changed one is updated (updated_at moves), a new one is inserted, and a row
// whose file is gone is deleted. A second run with no change writes nothing.
// A run that would delete more than half the stored pages needs
// --allow-mass-delete. --dry-run prints the plan and writes nothing.
//
// Runs on the service role: SUPABASE_URL + SUPABASE_SERVICE_KEY, read from
// the environment or from .env in the repo root.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { filter, map, pluck, splitEvery } from 'ramda'

import {
  collect,
  duplicateSlugs,
  isPagePath,
  isStrayPath,
  parsePageFile,
  planSync,
  removalRefusal,
  type StoredPage,
  type WikiPage,
} from './goonwiki/page.ts'
import { sudoSupabase } from './supabase.js'

const PAGE_SIZE = 1000
// Bodies run to 400 KB, so writes go in small batches.
const WRITE_CHUNK = 25
const DELETE_CHUNK = 200

const die = (message: string): never => {
  console.error(`goonwiki-import: ${message}`)
  process.exit(1)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    'allow-mass-delete': { type: 'boolean', default: false },
  },
})

const expandHome = (path: string): string => path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')

const pagesFolder = (given: string): string => {
  const dir = resolve(expandHome(given))
  const nested = join(dir, 'pages')
  const isDir = (path: string) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
  if (!isDir(dir)) return die(`${dir} is not a folder`)
  return isDir(nested) ? nested : dir
}

const readStored = async (from = 0, acc: StoredPage[] = []): Promise<StoredPage[]> => {
  const { data, error } = await sudoSupabase
    .from('goonwiki_page')
    .select('slug, content_hash')
    .order('slug')
    .range(from, from + PAGE_SIZE - 1)
  if (error) throw new Error(`reading goonwiki_page failed: ${error.message}`)
  const rows = (data ?? []) as StoredPage[]
  acc.push(...rows)
  return rows.length < PAGE_SIZE ? acc : readStored(from + PAGE_SIZE, acc)
}

const sequential = <T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> =>
  items.reduce((chain: Promise<void>, item) => chain.then(() => fn(item)), Promise.resolve())

const writePages = (pages: WikiPage[], at: string): Promise<void> =>
  sequential(splitEvery(WRITE_CHUNK, pages), async (chunk) => {
    const rows = map((p) => ({ slug: p.slug, title: p.title, body: p.body, updated_at: at }), chunk)
    const { error } = await sudoSupabase.from('goonwiki_page').upsert(rows, { onConflict: 'slug' })
    if (error) throw new Error(`writing goonwiki_page failed: ${error.message}`)
  })

const removePages = (slugs: string[]): Promise<void> =>
  sequential(splitEvery(DELETE_CHUNK, slugs), async (chunk) => {
    const { error } = await sudoSupabase.from('goonwiki_page').delete().in('slug', chunk)
    if (error) throw new Error(`deleting from goonwiki_page failed: ${error.message}`)
  })

const run = async () => {
  if (positionals.length !== 1)
    die('usage: pnpm run goonwiki-import -- <cleared folder> [--dry-run] [--allow-mass-delete]')
  const folder = pagesFolder(positionals[0])
  const files = (readdirSync(folder, { recursive: true }) as string[]).sort()
  const plainFiles = filter((f: string) => !statSync(join(folder, f)).isDirectory(), files)
  const strays = filter(isStrayPath, plainFiles)
  if (strays.length) die(`files that are not cleared pages are in ${folder}:\n  ${strays.join('\n  ')}`)

  const { pages, problems } = collect(
    map((f: string) => parsePageFile(f, readFileSync(join(folder, f), 'utf8')), filter(isPagePath, plainFiles))
  )
  if (problems.length) die(`these files are not cleared pages:\n  ${problems.join('\n  ')}`)
  const dupes = duplicateSlugs(pages)
  if (dupes.length) die(`two files give one slug: ${dupes.join(', ')}`)

  const stored = await readStored()
  const plan = planSync(stored, pages)
  const refusal = removalRefusal(stored.length, pages.length, plan.remove.length, values['allow-mass-delete'])
  if (refusal) die(refusal)

  console.log(
    `${folder}: ${pages.length} pages. Insert ${plan.insert.length}, update ${plan.update.length}, unchanged ${plan.unchanged}, remove ${plan.remove.length}.`
  )
  if (plan.remove.length) console.log(`remove: ${plan.remove.join(', ')}`)
  if (values['dry-run']) return console.log('dry run: nothing written')

  const at = new Date().toISOString()
  await writePages([...plan.insert, ...plan.update], at)
  await removePages(plan.remove)
  const after = await readStored()
  const check = planSync(after, pages)
  if (check.insert.length || check.update.length || check.remove.length)
    die(
      `after the run the table still differs from the folder: ${JSON.stringify(map(pluck('slug'), [check.insert, check.update]))}`
    )
  console.log(`done: goonwiki_page holds ${after.length} pages, the same as the folder`)
}

run().catch((err) => die(err instanceof Error ? err.message : String(err)))
