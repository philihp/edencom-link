// DB-backed loader for the stargate graph, over the sde_system_jump view (see
// supabase/migrations/20260902092205_sde_system_jump.sql). Answers "which
// systems are one jump from here" without an ESI call, which is what lets a
// map be drawn from data rather than from a hand-maintained system list.
//
// Unlike the by-id loaders in src/sde*.ts, the unit of caching is the WHOLE
// graph rather than individual rows — the view is ~14k tiny rows and a
// consumer walks it, so paging it once per process (6h, the same TTL as the
// by-id caches) beats a round trip per hop. An empty graph is never cached:
// on a fresh deploy before the first ingest the mirror table has no rows, and
// holding that for 6h would keep every map blank long after the ingest lands.
import { forEach, reduce } from 'ramda'

import { TTL_MS } from './sdeCache'
import { sdeSupabase } from './utils/supabase/sde'

// system id -> the systems one jump away, both directions present (CCP ships
// every gate with its paired return gate).
export type SystemJumpGraph = Map<number, number[]>

type EdgeRow = { from_system_id: number; to_system_id: number }

const PAGE_SIZE = 1000

// Tail-recursive range paging past PostgREST's 1000-row cap (CLAUDE.md's
// pagination shape); the accumulator is push-mutated so the walk stays O(n).
const readEdges = async (from = 0, acc: EdgeRow[] = []): Promise<EdgeRow[]> => {
  const { data, error } = await sdeSupabase()
    .from('sde_system_jump')
    .select('from_system_id, to_system_id')
    .order('from_system_id')
    .order('to_system_id')
    .range(from, from + PAGE_SIZE - 1)
  if (error) throw new Error(`reading sde_system_jump failed: ${error.message}`)
  const rows = (data ?? []) as EdgeRow[]
  forEach((row) => acc.push(row), rows)
  return rows.length < PAGE_SIZE ? acc : readEdges(from + PAGE_SIZE, acc)
}

const buildGraph = (edges: EdgeRow[]): SystemJumpGraph =>
  reduce(
    (graph: SystemJumpGraph, { from_system_id, to_system_id }) => {
      const neighbours = graph.get(from_system_id)
      if (neighbours) neighbours.push(to_system_id)
      else graph.set(from_system_id, [to_system_id])
      return graph
    },
    new Map(),
    edges
  )

let cached: { at: number; graph: Promise<SystemJumpGraph> } | null = null

// The whole gate graph, cached per process. Concurrent warm-ups share the
// in-flight promise; a failure (or an empty mirror) clears the entry so the
// next call re-queries instead of serving a blank graph for 6h.
export const getSystemJumpGraph = (): Promise<SystemJumpGraph> => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.graph
  const graph = readEdges()
    .then(buildGraph)
    .then((built) => {
      if (built.size === 0) cached = null
      return built
    })
    .catch((e: unknown) => {
      console.error(`[sdeJumps] graph load failed: ${e instanceof Error ? e.message : String(e)}`)
      cached = null
      return new Map() as SystemJumpGraph
    })
  cached = { at: Date.now(), graph }
  return graph
}
