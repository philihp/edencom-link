// The pure rules of the Goonwiki import (docs/goonwiki-lookup.md): how one
// cleared Markdown file becomes one goonwiki_page row, and what a run must
// insert, update and delete to make the table match the folder. No I/O, so
// the CLI (src/goonwikiImport.ts) and the tests share it.
//
// A cleared page is a `.md` file whose front matter is `key: <JSON value>`
// lines between two `---` lines (the rewrite's converter writes it that way),
// with a `title`. A file without that front matter is not a cleared page, and
// the import refuses the whole run rather than load it.
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  ascend,
  complement,
  countBy,
  filter,
  fromPairs,
  has,
  map,
  partition,
  pipe,
  prop,
  reject,
  sortWith,
  toPairs,
} from 'ramda'

export type WikiPage = { slug: string; title: string; body: string }
export type StoredPage = { slug: string; content_hash: string }
export type Parsed = { ok: true; page: WikiPage } | { ok: false; path: string; reason: string }

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/

// `geography/c-lp3n.md` → `geography/c-lp3n`. Backslashes become slashes so
// a Windows walk names the same page. Null when what is left is not a slug
// (an upper-case letter, a space, a `..`): the import reports it.
export const slugOf = (relPath: string): string | null => {
  const slug = posix.normalize(relPath.replaceAll('\\', '/')).replace(/\.md$/, '')
  return SLUG_PATTERN.test(slug) && !slug.split('/').includes('..') ? slug : null
}

// The text in, `{ meta, body }` out; null when the file does not open with a
// front matter block.
export const splitFrontMatter = (text: string): { meta: Record<string, unknown>; body: string } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const meta = pipe(
    (block: string) => block.split(/\r?\n/),
    reject((line: string) => line.trim() === ''),
    map((line: string): [string, unknown] => {
      const at = line.indexOf(':')
      if (at < 1) return ['', undefined]
      const raw = line.slice(at + 1).trim()
      return [line.slice(0, at).trim(), parseValue(raw)]
    }),
    filter(([key]: [string, unknown]) => key !== ''),
    fromPairs
  )(match[1])
  return { meta, body: text.slice(match[0].length) }
}

const parseValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// A link between cleared pages is a relative path to a `.md` file. In the
// table it becomes `wiki:<slug>`, which read_wiki_page reads, so a reader can
// follow it. Absolute URLs, and paths that climb out of the folder, stay.
export const rewriteLinks =
  (slug: string) =>
  (body: string): string =>
    body.replace(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g, (whole, target: string, anchor: string | undefined) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return whole
      const resolved = slugOf(posix.join(posix.dirname(slug), target))
      return resolved ? `](wiki:${resolved}${anchor ?? ''})` : whole
    })

export const parsePageFile = (relPath: string, text: string): Parsed => {
  const slug = slugOf(relPath)
  if (!slug) return { ok: false, path: relPath, reason: 'the path does not make a slug' }
  const split = splitFrontMatter(text)
  if (!split) return { ok: false, path: relPath, reason: 'no front matter' }
  const title = split.meta.title
  if (typeof title !== 'string' || title.trim() === '')
    return { ok: false, path: relPath, reason: 'no title in the front matter' }
  return { ok: true, page: { slug, title: title.trim(), body: rewriteLinks(slug)(split.body.trim()) } }
}

// Must equal the generated column: md5(title || E'\n' || body), over UTF-8.
export const contentHash = ({ title, body }: Pick<WikiPage, 'title' | 'body'>): string =>
  createHash('md5').update(`${title}\n${body}`, 'utf8').digest('hex')

export const duplicateSlugs = (pages: WikiPage[]): string[] =>
  pipe(
    countBy((p: WikiPage) => p.slug),
    toPairs,
    filter(([, n]: [string, number]) => n > 1),
    map(([slug]: [string, number]) => slug)
  )(pages).sort()

export type SyncPlan = { insert: WikiPage[]; update: WikiPage[]; unchanged: number; remove: string[] }

const bySlug = sortWith<WikiPage>([ascend((p: WikiPage) => p.slug)])

// What one run writes: a page the table lacks is inserted, a page whose hash
// differs is updated, a row no page names is removed. Deterministic: every
// list is in slug order.
export const planSync = (stored: StoredPage[], pages: WikiPage[]): SyncPlan => {
  const storedHash: Record<string, string> = fromPairs(map((s) => [s.slug, s.content_hash], stored))
  const present: Record<string, true> = fromPairs(map((p) => [p.slug, true as const], pages))
  const [known, fresh] = partition((p: WikiPage) => has(p.slug, storedHash), bySlug(pages))
  const [same, changed] = partition((p: WikiPage) => storedHash[p.slug] === contentHash(p), known)
  const remove = pipe(
    map(prop<string>('slug')) as (rows: StoredPage[]) => string[],
    filter(complement((slug: string) => has(slug, present)))
  )(stored).sort()
  return { insert: fresh, update: changed, unchanged: same.length, remove }
}

// A run that would delete more than half of what is stored is far more likely
// a wrong folder than a real clean-up, so the CLI wants --allow-mass-delete
// for it. An empty folder is always refused, flag or no flag.
export const removalRefusal = (
  storedCount: number,
  pageCount: number,
  removeCount: number,
  allowMassDelete = false
): string | null =>
  pageCount === 0
    ? 'the folder holds no cleared pages; nothing was changed'
    : !allowMassDelete && storedCount > 0 && removeCount * 2 > storedCount
      ? `this run would remove ${removeCount} of ${storedCount} stored pages; check the folder, or pass --allow-mass-delete`
      : null

// Split parsed files into pages and refusals.
export const collect = (parsed: Parsed[]): { pages: WikiPage[]; problems: string[] } => {
  const isPage = (p: Parsed): p is Extract<Parsed, { ok: true }> => p.ok
  const isRefusal = (p: Parsed): p is Extract<Parsed, { ok: false }> => !p.ok
  return {
    pages: parsed.filter(isPage).map((p) => p.page),
    problems: parsed.filter(isRefusal).map((b) => `${b.path}: ${b.reason}`),
  }
}

// Which files under the folder are pages: Markdown in a section folder
// (`geography/c-lp3n.md`), none of it hidden. A file at the top of the folder
// (index.md, review.md, redirects.csv) describes the folder, not a page.
export const isPagePath = (relPath: string): boolean => {
  const parts = relPath.replaceAll('\\', '/').split('/')
  return parts.length >= 2 && relPath.endsWith('.md') && !parts.some((part) => part.startsWith('.'))
}

// A file in a section folder that is neither a page nor hidden: the import
// refuses the run, so nothing uncleared sits beside the pages unnoticed.
export const isStrayPath = (relPath: string): boolean => {
  const parts = relPath.replaceAll('\\', '/').split('/')
  return parts.length >= 2 && !relPath.endsWith('.md') && !parts.some((part) => part.startsWith('.'))
}
