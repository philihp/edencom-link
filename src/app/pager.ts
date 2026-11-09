// Read every row of a select past PostgREST's max_rows cap (1000). Shared by
// the pages that read a long history (/market, /industry, /structure).
//
// The old pager read one page, waited, then read the next. A long history
// thus cost one round trip per 1000 rows, one after the other. This pager
// reads the first page with an exact count, then reads all the other pages
// at the same time. The page load waits for two round trips, not N.
//
// Rows can arrive while the pages load (an extract job writes the same
// tables). A new row moves the rows below it down by one, so two pages can
// both hold a row, and the last page can push a row out past the count.
// The pager removes the duplicates by key, and when the last page is full it
// continues one page at a time until a short page.

import { uniqBy } from 'ramda'

export const PAGE_SIZE = 1000

export type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>

// `count` is 'exact' on the first request only. The caller passes it to
// `.select(columns, { count })`.
export type BuildPage<T> = (from: number, to: number, count?: 'exact') => PageResult<T>

// The [from, to] ranges after the first page, for `total` rows. Pure.
export const restRanges = (total: number, pageSize: number = PAGE_SIZE): Array<[number, number]> =>
  Array.from({ length: Math.max(0, Math.ceil(total / pageSize) - 1) }, (_, i) => {
    const from = (i + 1) * pageSize
    return [from, from + pageSize - 1] as [number, number]
  })

// One page after the other, until a short page. Tail-recursive; the
// accumulator is push-mutated so that the copy is O(n), not O(n^2).
export const fetchSequential = async <T>(build: BuildPage<T>, from = 0, acc: T[] = []): Promise<T[]> => {
  const { data, error } = await build(from, from + PAGE_SIZE - 1)
  if (error || !data) return acc
  acc.push(...data)
  return data.length < PAGE_SIZE ? acc : fetchSequential(build, from + PAGE_SIZE, acc)
}

// The first page with a count, then the other pages in parallel. `key` names
// a row, so that a row two pages hold is kept one time. The rows keep the
// order of the select.
export const fetchAllRows = async <T>(build: BuildPage<T>, key: (row: T) => string): Promise<T[]> => {
  const first = await build(0, PAGE_SIZE - 1, 'exact')
  if (first.error || !first.data) return []
  if (first.data.length < PAGE_SIZE) return first.data
  // No count: read the old way.
  if (first.count == null) return fetchSequential(build, PAGE_SIZE, [...first.data])
  const ranges = restRanges(first.count)
  const pages = await Promise.all(ranges.map(([from, to]) => build(from, to)))
  const rows = [first.data, ...pages.map((p) => (p.error || !p.data ? [] : p.data))]
  const lastPage = rows[rows.length - 1]
  const tail = lastPage.length < PAGE_SIZE ? [] : await fetchSequential(build, (ranges.length + 1) * PAGE_SIZE, [])
  return uniqBy(key, [...rows.flat(), ...tail])
}
