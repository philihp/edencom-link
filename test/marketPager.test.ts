// Unit coverage for the market page's pager (src/app/market/pager.ts): the
// page ranges after the first page, and the read of all pages with a count.
import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchAllRows, PAGE_SIZE, restRanges, type BuildPage } from '../src/app/market/pager.ts'

test('restRanges: no pages after the first when the rows fit in one page', () => {
  assert.deepEqual(restRanges(0, 10), [])
  assert.deepEqual(restRanges(10, 10), [])
})

test('restRanges: one range per page after the first', () => {
  assert.deepEqual(restRanges(25, 10), [
    [10, 19],
    [20, 29],
  ])
  assert.deepEqual(restRanges(30, 10), [
    [10, 19],
    [20, 29],
  ])
})

type Row = { id: number }

// A table of `rows` behind a fake select. `before(n)` can change the table
// before request n is answered.
const table = (rows: Row[], before: (n: number, rows: Row[]) => void = () => {}) => {
  const calls: Array<{ from: number; to: number; count?: string }> = []
  const build: BuildPage<Row> = (from, to, count) => {
    before(calls.length, rows)
    calls.push({ from, to, count })
    return Promise.resolve({
      data: rows.slice(from, to + 1),
      error: null,
      count: count === 'exact' ? rows.length : null,
    })
  }
  return { build, calls }
}

const ids = (n: number, start = 0): Row[] => Array.from({ length: n }, (_, i) => ({ id: start + i }))
const key = (r: Row) => String(r.id)

test('fetchAllRows: one request when the first page is short', async () => {
  const { build, calls } = table(ids(5))
  assert.deepEqual(await fetchAllRows(build, key), ids(5))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].count, 'exact')
})

test('fetchAllRows: reads the other pages after the count, in order', async () => {
  const rows = ids(2 * PAGE_SIZE + 7)
  const { build, calls } = table(rows)
  assert.deepEqual(await fetchAllRows(build, key), rows)
  assert.equal(calls.length, 3)
  assert.deepEqual(
    calls.slice(1).map((c) => c.count),
    [undefined, undefined]
  )
})

test('fetchAllRows: a row that arrives at the top during the read is not counted two times', async () => {
  // After the count, a new row goes in at the top, so every row moves down one.
  const rows = ids(PAGE_SIZE + 5)
  const { build } = table(rows, (n, r) => {
    if (n === 1) r.unshift({ id: -1 })
  })
  const got = await fetchAllRows(build, key)
  assert.equal(new Set(got.map(key)).size, got.length)
  // Every row that was there at the count is read.
  assert.ok(rows.every((r) => r.id === -1 || got.some((g) => g.id === r.id)))
})

test('fetchAllRows: a full last page continues until a short page', async () => {
  // The count says two full pages, but rows arrive before the second page.
  const rows = ids(2 * PAGE_SIZE)
  const { build, calls } = table(rows, (n, r) => {
    if (n === 1) r.unshift(...ids(3, -10))
  })
  const got = await fetchAllRows(build, key)
  assert.equal(calls.length, 3)
  assert.ok(ids(2 * PAGE_SIZE).every((r) => got.some((g) => g.id === r.id)))
})
