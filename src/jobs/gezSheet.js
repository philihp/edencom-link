import { chain, drop, filter, map, pipe, reduce, reject, trim, uniqBy } from 'ramda'

// The pure half of the one-time GEZ import (src/jobs/importGezStructures.js):
// the "GEZ Rig List" tab of Goonswarm's public GEZ Tracker sheet, turned into
// stub rows for corp_structure / corp_structure_rig. No I/O here — names are
// resolved to ids by the caller.
//
// The tab is one row per structure: a blank first column, then System (filled
// on the first structure of a system only), Structure (the hull), Name,
// Service Modules (a comma list in the sheet's own words) and up to three rigs.

// A structure the sheet lists that we could not match to a real id gets a
// synthetic one in a band no Upwell structure uses (real ids sit around
// 1.0e12–1.1e12). Positive, so `/structure/[structureId]` (which accepts only
// digits) still opens it, and under 2^53 so it survives a JS number. The
// corp-assets rig rewrite leaves this band alone, since no scan will ever see
// these structures.
export const STUB_STRUCTURE_ID_BASE = 9_000_000_000_000_000
const STUB_SPAN = 1_000_000_000_000

export const isStubStructureId = (id) => Number(id) >= STUB_STRUCTURE_ID_BASE

// cyrb53: a 53-bit string hash in plain JS, keeping this module free of Node
// built-ins (corpAssets.js imports it for the id band).
const cyrb53 = (str) => {
  const [h1, h2] = reduce(
    ([a, b], ch) => {
      const c = ch.charCodeAt(0)
      return [Math.imul(a ^ c, 2654435761), Math.imul(b ^ c, 1597334677)]
    },
    [0xdeadbeef, 0x41c6ce57],
    [...str]
  )
  const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & b) + (a >>> 0)
}

// Deterministic, so a re-run upserts the same rows instead of adding twins.
export const stubStructureId = (systemId, hullTypeId, name) =>
  STUB_STRUCTURE_ID_BASE + (cyrb53(`${systemId}|${hullTypeId}|${name}`) % STUB_SPAN)

// RFC 4180, enough for Google's CSV export: quoted fields, "" escapes, CRLF.
export const parseCsv = (text) => {
  const end = reduce(
    (st, ch) => {
      if (st.quoted) {
        if (st.pendingQuote) {
          if (ch === '"') return { ...st, field: st.field + '"', pendingQuote: false }
          st = { ...st, quoted: false, pendingQuote: false }
        } else if (ch === '"') return { ...st, pendingQuote: true }
        else return { ...st, field: st.field + ch }
      }
      if (ch === '"') return { ...st, quoted: true }
      if (ch === ',') return { ...st, row: [...st.row, st.field], field: '' }
      if (ch === '\r') return st
      if (ch === '\n') {
        st.rows.push([...st.row, st.field])
        return { ...st, row: [], field: '' }
      }
      return { ...st, field: st.field + ch }
    },
    { rows: [], row: [], field: '', quoted: false, pendingQuote: false },
    [...text]
  )
  const last = [...end.row, end.field]
  if (last.length > 1 || last[0] !== '') end.rows.push(last)
  return end.rows
}

const splitList = pipe(
  (s) => s.split(','),
  map(trim),
  reject((s) => s === '')
)

// → [{ system, hull, name, services: [sheet words], rigs: [rig names] }], the
// System column carried down to the structures listed under it.
/** @typedef {{ system: string, hull: string, name: string, services: string[], rigs: string[] }} SheetRow */

/** @type {(text: string) => SheetRow[]} */
export const parseRigList = (text) =>
  pipe(
    parseCsv,
    drop(1),
    reduce((acc, cols) => {
      const [, system, hull, name, services = '', ...rigs] = map((c) => trim(c ?? ''), cols)
      const current = system || acc.system
      if (!hull || !name || !current) return { ...acc, system: current }
      acc.rows.push({
        system: current,
        hull,
        name,
        services: splitList(services),
        rigs: filter((r) => r !== '', rigs.slice(0, 3)),
      })
      return { ...acc, system: current }
    }, /** @type {{ system: string | null, rows: SheetRow[] }} */ ({ system: null, rows: [] })),
    (acc) => acc.rows,
    // The sheet lists a few structures twice (DW-N2S's whole block, for one).
    uniqBy((r) => `${r.system}|${r.hull}|${r.name}`)
  )(text)

// The sheet's service words → ESI's service names, as /structure renders them.
// "Research" on the sheet is the lab trio (its rigs are ME/TE/copy).
const SERVICE_NAMES = {
  manufacturing: ['Manufacturing (Standard)'],
  capital: ['Manufacturing (Capitals)'],
  supercapital: ['Manufacturing (Supercapitals)'],
  research: ['Material Efficiency Research', 'Time Efficiency Research', 'Blueprint Copying'],
  invention: ['Invention'],
  invent: ['Invention'],
  composite: ['Composite Reactions'],
  hybrid: ['Hybrid Reactions'],
  bio: ['Biochemical Reactions'],
  biochem: ['Biochemical Reactions'],
  reproc: ['Reprocessing'],
  reprocessing: ['Reprocessing'],
}

// → { services: [{ name, state: 'online' }], unknown: [sheet words with no mapping] }
export const toServices = (words) => ({
  services: pipe(
    chain((w) => SERVICE_NAMES[w.toLowerCase()] ?? []),
    uniqBy((n) => n),
    map((name) => ({ name, state: 'online' }))
  )(words),
  unknown: reject((w) => SERVICE_NAMES[w.toLowerCase()], words),
})

// The in-game name of a structure is "<system> - <name>"; that's how a sheet
// row finds its real id in universe_structure.
export const structureFullName = (system, name) => `${system} - ${name}`

export const rigSlotRows = (structureId, corporationId, rigTypeIds) =>
  rigTypeIds.map((type_id, i) => ({
    structure_id: structureId,
    location_flag: `RigSlot${i}`,
    type_id,
    corporation_id: corporationId,
  }))
