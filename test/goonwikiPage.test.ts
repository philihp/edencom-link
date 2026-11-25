// The Goonwiki import's pure rules (src/goonwiki/page.ts): how a cleared file
// becomes a row, and what a run inserts, updates and removes so the table
// matches the folder — including that a page deleted from the folder is
// removed, and that a second run with no change writes nothing.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  collect,
  contentHash,
  duplicateSlugs,
  isPagePath,
  isStrayPath,
  parsePageFile,
  planSync,
  removalRefusal,
  rewriteLinks,
  slugOf,
  type StoredPage,
  type WikiPage,
} from '../src/goonwiki/page.ts'

const FILE = [
  '---',
  'title: "C-LP3N"',
  'section: "geography"',
  'source_categories: ["Branch","Former Staging"]',
  'status: []',
  '---',
  '',
  '# C-LP3N',
  '',
  'Staging system of [Fidelas Constans](../history/alliances/fidelas-constans.md), after [Phoebe](../reference/phoebe.md#jump-changes).',
  'See [dotlan](https://evemaps.dotlan.net/system/C-LP3N) and [the old page](Providence_(region)).',
  '',
].join('\n')

const stored = (page: WikiPage): StoredPage => ({ slug: page.slug, content_hash: contentHash(page) })

test('slugOf: the path less .md, refusing what is not a slug', () => {
  assert.equal(slugOf('geography/c-lp3n.md'), 'geography/c-lp3n')
  assert.equal(slugOf('history\\alliances\\goonswarm.md'), 'history/alliances/goonswarm')
  assert.equal(slugOf('Geography/Bad Name.md'), null)
  assert.equal(slugOf('../outside.md'), null)
})

test('parsePageFile: title from the front matter, body without it, links as wiki: slugs', () => {
  const parsed = parsePageFile('geography/c-lp3n.md', FILE)
  assert.ok(parsed.ok)
  assert.equal(parsed.page.slug, 'geography/c-lp3n')
  assert.equal(parsed.page.title, 'C-LP3N')
  assert.ok(parsed.page.body.startsWith('# C-LP3N'))
  assert.ok(!parsed.page.body.includes('source_categories'))
  assert.match(parsed.page.body, /\(wiki:history\/alliances\/fidelas-constans\)/)
  assert.match(parsed.page.body, /\(wiki:reference\/phoebe#jump-changes\)/)
  assert.match(parsed.page.body, /\(https:\/\/evemaps\.dotlan\.net\/system\/C-LP3N\)/)
  assert.match(parsed.page.body, /\(Providence_\(region\)/)
})

test('parsePageFile: a file with no front matter or no title is refused', () => {
  assert.deepEqual(parsePageFile('misc/raw.md', '== Raw wikitext ==\n'), {
    ok: false,
    path: 'misc/raw.md',
    reason: 'no front matter',
  })
  const untitled = parsePageFile('misc/x.md', '---\nsection: "misc"\n---\nbody')
  assert.equal(untitled.ok, false)
})

test('rewriteLinks: a path that climbs out of the folder stays as written', () => {
  assert.equal(rewriteLinks('geography/a')('[x](../../outside.md)'), '[x](../../outside.md)')
  assert.equal(rewriteLinks('geography/a')('[x](b.md)'), '[x](wiki:geography/b)')
})

test('contentHash: md5 of title, newline, body, as the generated column computes it', () => {
  const page = { title: 'Ålesund', body: 'Body — with “quotes”' }
  assert.equal(contentHash(page), createHash('md5').update('Ålesund\nBody — with “quotes”', 'utf8').digest('hex'))
})

test('isPagePath / isStrayPath: pages live in section folders; top-level files describe the folder', () => {
  assert.equal(isPagePath('geography/c-lp3n.md'), true)
  assert.equal(isPagePath('history/alliances/goonswarm.md'), true)
  assert.equal(isPagePath('index.md'), false)
  assert.equal(isPagePath('review.md'), false)
  assert.equal(isPagePath('history/.DS_Store'), false)
  assert.equal(isStrayPath('history/.DS_Store'), false)
  assert.equal(isStrayPath('redirects.csv'), false)
  assert.equal(isStrayPath('misc/export.jsonl.gz'), true)
})

const page = (slug: string, body = `Body of ${slug}`): WikiPage => ({ slug, title: slug.split('/').pop()!, body })

test('planSync: inserts new pages, updates changed ones, leaves the rest', () => {
  const a = page('glossary/a')
  const b = page('glossary/b')
  const plan = planSync([stored(a), stored(b)], [a, { ...b, body: 'changed' }, page('glossary/c')])
  assert.deepEqual(
    plan.insert.map((p) => p.slug),
    ['glossary/c']
  )
  assert.deepEqual(
    plan.update.map((p) => p.slug),
    ['glossary/b']
  )
  assert.equal(plan.unchanged, 1)
  assert.deepEqual(plan.remove, [])
})

test('planSync: a page deleted from the folder is removed', () => {
  const a = page('glossary/a')
  const b = page('glossary/b')
  const c = page('glossary/c')
  const plan = planSync([stored(c), stored(a), stored(b)], [a, c])
  assert.deepEqual(plan.remove, ['glossary/b'])
  assert.deepEqual(plan.insert, [])
  assert.deepEqual(plan.update, [])
})

test('planSync: a second run over the same folder writes nothing', () => {
  const pages = [page('a/x'), page('a/y'), page('b/z')]
  const first = planSync([], pages)
  const afterFirst = [...first.insert, ...first.update].map(stored)
  const second = planSync(afterFirst, pages)
  assert.deepEqual(second, { insert: [], update: [], unchanged: 3, remove: [] })
})

test('removalRefusal: an empty folder, or removing over half, needs a second look', () => {
  assert.match(removalRefusal(100, 0, 100)!, /no cleared pages/)
  assert.match(removalRefusal(100, 40, 60)!, /--allow-mass-delete/)
  assert.equal(removalRefusal(100, 99, 1), null)
  assert.equal(removalRefusal(0, 10, 0), null)
  assert.equal(removalRefusal(100, 40, 60, true), null)
  assert.match(removalRefusal(100, 0, 100, true)!, /no cleared pages/)
})

test('collect and duplicateSlugs: refusals are named, one slug never comes from two files', () => {
  const { pages, problems } = collect([
    parsePageFile('geography/c-lp3n.md', FILE),
    parsePageFile('misc/raw.md', 'no front matter'),
  ])
  assert.equal(pages.length, 1)
  assert.deepEqual(problems, ['misc/raw.md: no front matter'])
  assert.deepEqual(duplicateSlugs([page('a/x'), page('a/x'), page('a/y')]), ['a/x'])
})
