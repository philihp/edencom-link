import { chain, filter, map, pipe, reject, uniq } from 'ramda'

// Hand-inferred fittings for the structures our jobs run in but no director of
// ours scans (docs/structure-universe/design.md, "Hand-inferred fittings").
// The pure half of src/jobs/importInferredStructures.js: the table and its
// checks, no I/O.
//
// A structure here was never scanned, so ESI has told us nothing beyond its
// name, hull, system and owner (the public directory, universe_structure).
// What it is FITTED with is read from two things a name and a job history
// give away: the owner's naming convention — GSF names an industry structure
// after its rigs ("T2 Adv L T1 Basic L" is two tech II advanced-large-ship
// rigs and one tech I basic-large-ship rig, the same way every scanned GEZ
// Raitaru reads) — and what our own jobs actually did there (a Tatara that
// ran 3,551 reactions has reactors online; an Azbel that ran 3,300 copies has
// a research lab). Each entry says which. These are GUESSES, written down so
// they can be checked and corrected in one place; a director scan replaces
// them the moment one exists (the importer never overwrites a scanned row).
//
// The second list re-keys GEZ stubs. importGezStructures.js matched the
// alliance sheet to real ids by exact "<system> - <name>", and a sheet row
// whose in-game name differs ("GEZ T2 Ship Comp Struct" against the real
// "GEZ - T2 Ship, Comps, Structures") got a synthetic id in the stub band
// instead. Those stubs describe a structure the directory knows under its
// real id — the id our industry jobs carry — so the sheet's services and rigs
// move onto the real row and the stub goes.

// ESI's service names, as corp_structure.services carries them (the keys of
// SERVICE_MODULE_NAMES in src/app/structure/serviceIcons.ts).
export const SERVICE_NAMES = [
  'Manufacturing (Standard)',
  'Manufacturing (Capitals)',
  'Manufacturing (Supercapitals)',
  'Blueprint Copying',
  'Material Efficiency Research',
  'Time Efficiency Research',
  'Invention',
  'Market Hub',
  'Clone Bay',
  'Reprocessing',
  'Composite Reactions',
  'Biochemical Reactions',
  'Hybrid Reactions',
  'Moon Drilling',
]

// Which rig size each Upwell hull takes. A Raitaru fits M-Set rigs, an Azbel
// L-Set, a Sotiyo XL-Set; a rig of the wrong size is a typo, caught by
// inferredProblems below.
export const RIG_SET_BY_HULL = {
  Raitaru: 'M-Set',
  Athanor: 'M-Set',
  Astrahus: 'M-Set',
  Azbel: 'L-Set',
  Tatara: 'L-Set',
  Fortizar: 'L-Set',
  Sotiyo: 'XL-Set',
  Keepstar: 'XL-Set',
}

export const MAX_RIGS = 3

// Owners, named once. The importer upserts these into `corporation` (the
// character-directory job keeps the row current afterwards) and seeds each
// one's default alliance structure share (src/jobs/structureShareDefault.js),
// which is what lets an alliance-mate's account read the rows at all —
// corp_structure's RLS is own corps or a share's audience, nothing else.
const GOONWAFFE = { corporationId: 667531913, name: 'GoonWaffe', allianceId: 1354830081 }
const GSF_LPR = { corporationId: 98718076, name: 'GSF Logistics and Posting Reserves', allianceId: 1354830081 }
const DJS_RETIREMENT_FUND = { corporationId: 1344654522, name: "DJ's Retirement Fund", allianceId: 1354830081 }
const REKIUM_HOLDINGS = { corporationId: 98565450, name: 'Rekium Holdings', allianceId: 1354830081 }

/**
 * @typedef {{ corporationId: number, name: string, allianceId: number | null }} Owner
 * @typedef {{
 *   structureId: number,
 *   name: string,
 *   hull: keyof typeof RIG_SET_BY_HULL,
 *   owner: Owner,
 *   ownerGuessed?: boolean,
 *   services: string[],
 *   rigs: string[],
 *   evidence: string,
 * }} InferredStructure
 */

/** @type {InferredStructure[]} */
export const INFERRED_STRUCTURES = [
  {
    structureId: 1049984316241,
    name: '27-HP0 - Daniel C Sotiyo - T1 Ships & Equ',
    hull: 'Sotiyo',
    owner: GOONWAFFE,
    services: ['Manufacturing (Standard)'],
    rigs: [
      'Standup XL-Set Ship Manufacturing Efficiency I',
      'Standup XL-Set Equipment and Consumable Manufacturing Efficiency I',
    ],
    evidence:
      '11,547 manufacturing jobs: mining crystals, construction components, modules, HACs, fighters, drones — subcapital ships and equipment, no capital hull built. "T1" is the rig tier.',
  },
  {
    structureId: 1050041077791,
    name: '27-HP0 - HDUMP - T1 Copy + Invention',
    hull: 'Azbel',
    owner: GOONWAFFE,
    services: ['Blueprint Copying', 'Material Efficiency Research', 'Time Efficiency Research', 'Invention'],
    rigs: ['Standup L-Set Blueprint Copy Optimization I', 'Standup L-Set Invention Optimization I'],
    evidence:
      '3,300 copy, 1,377 invention, 94 ME and 84 TE jobs. A research lab provides copying with both research services; an invention lab the fourth.',
  },
  {
    structureId: 1050041109418,
    name: '27-HP0 - HDUMP - T1 Research',
    hull: 'Azbel',
    owner: GOONWAFFE,
    services: ['Material Efficiency Research', 'Time Efficiency Research', 'Blueprint Copying'],
    rigs: ['Standup L-Set ME Research Optimization I', 'Standup L-Set TE Research Optimization I'],
    evidence: '1,253 ME and 948 TE jobs, 7 copies. The lab provides copying too; the name rigs it for research only.',
  },
  {
    structureId: 1050185373355,
    name: '27-HP0 - HDUMP - T1 Reactions',
    hull: 'Tatara',
    owner: GOONWAFFE,
    services: ['Composite Reactions', 'Biochemical Reactions', 'Hybrid Reactions'],
    rigs: ['Standup L-Set Reactor Efficiency I'],
    evidence:
      '3,551 reaction jobs (intermediates and composites). A Tatara named plain "Reactions" carries all three reactors, as the scanned "O-9G5Y - PRIVATE T1 Reactions" does.',
  },
  {
    structureId: 1050107826477,
    name: '27-HP0 - HDUMP - T1 Structure + Fuel',
    hull: 'Azbel',
    owner: GOONWAFFE,
    services: ['Manufacturing (Standard)'],
    rigs: ['Standup L-Set Structure Manufacturing Efficiency I'],
    evidence:
      '427 fuel-block jobs. The structure-manufacturing rig covers fuel blocks, which is how the scanned "Structure+Fuel" structures are rigged.',
  },
  {
    structureId: 1050041170519,
    name: 'X1-IZ0 - HDUMP - T1 Adv+CapComp & Fuel',
    hull: 'Azbel',
    owner: GOONWAFFE,
    services: ['Manufacturing (Standard)'],
    rigs: [
      'Standup L-Set Advanced Component Manufacturing Efficiency I',
      'Standup L-Set Basic Capital Component Manufacturing Efficiency I',
      'Standup L-Set Structure Manufacturing Efficiency I',
    ],
    evidence:
      '1,902 construction-component jobs, capital components and fuel blocks beside them — the scanned "HFC-AQ - Structure, Adv Comp, Basic Cap" fit, tech I.',
  },
  {
    structureId: 1054577764211,
    name: 'AGCP-I - PRIVATE T2 Cap&Comp T1 AdvComp',
    hull: 'Azbel',
    owner: GOONWAFFE,
    services: ['Manufacturing (Standard)', 'Manufacturing (Capitals)'],
    rigs: [
      'Standup L-Set Capital Ship Manufacturing Efficiency II',
      'Standup L-Set Basic Capital Component Manufacturing Efficiency II',
      'Standup L-Set Advanced Component Manufacturing Efficiency I',
    ],
    evidence:
      '601 advanced capital component, 473 capital component and 384 construction component jobs, plus 32 dreadnoughts and 15 carriers — a capital shipyard is online.',
  },
  {
    structureId: 1054577829390,
    name: 'AGCP-I - PRIVATE T2 Composite',
    hull: 'Tatara',
    owner: GOONWAFFE,
    ownerGuessed: true,
    services: ['Composite Reactions'],
    rigs: ['Standup L-Set Reactor Efficiency II'],
    evidence:
      '4,555 reaction jobs (intermediates and composites). The directory never resolved an owner; its two "AGCP-I - PRIVATE" siblings are GoonWaffe.',
  },
  {
    structureId: 1054577801558,
    name: 'AGCP-I - PRIVATE T2 Large Ships',
    hull: 'Raitaru',
    owner: GOONWAFFE,
    services: ['Manufacturing (Standard)'],
    rigs: [
      'Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II',
      'Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II',
      'Standup M-Set Basic Large Ship Manufacturing Material Efficiency II',
    ],
    evidence:
      '180 battleships, 60 freighters, 54 jump freighters, marauders and black ops — large hulls of both tiers.',
  },
  {
    structureId: 1050312717136,
    name: 'X-ARMF - T1 Capital',
    hull: 'Azbel',
    owner: REKIUM_HOLDINGS,
    services: ['Manufacturing (Capitals)'],
    rigs: ['Standup L-Set Capital Ship Manufacturing Efficiency I'],
    evidence: '34 dreadnoughts, 25 carriers and 3 force auxiliaries built here.',
  },
  {
    structureId: 1050315898777,
    name: 'X-ARMF - T2 Structutes T1 Invention',
    hull: 'Raitaru',
    owner: REKIUM_HOLDINGS,
    ownerGuessed: true,
    services: [
      'Manufacturing (Standard)',
      'Invention',
      'Blueprint Copying',
      'Material Efficiency Research',
      'Time Efficiency Research',
    ],
    rigs: [
      'Standup M-Set Structure Manufacturing Material Efficiency II',
      'Standup M-Set Structure Manufacturing Time Efficiency II',
      'Standup M-Set Invention Cost Optimization I',
    ],
    evidence:
      '368 copy jobs ran here, so a research lab is online beside the invention lab the name promises. No owner in the directory; the X-ARMF "T1 Capital" and "T1 Reactions" siblings are Rekium Holdings.',
  },
  {
    structureId: 1049802293716,
    name: 'R4N-LD - I R4N out of topes',
    hull: 'Sotiyo',
    owner: GSF_LPR,
    services: ['Material Efficiency Research', 'Time Efficiency Research', 'Blueprint Copying'],
    rigs: [],
    evidence:
      '29 copy, 8 ME and 7 TE jobs (capital blueprints). The name says nothing about rigs, so none are guessed.',
  },
  {
    structureId: 1049588174021,
    name: 'C-J6MT - 1st Taj Mahgoon',
    hull: 'Keepstar',
    owner: DJS_RETIREMENT_FUND,
    services: ['Manufacturing (Standard)', 'Market Hub', 'Clone Bay'],
    rigs: [],
    evidence:
      '670 manufacturing jobs (rockets, shuttles, cruisers, fuel). The market hub and clone bay are what a staging Keepstar carries; nothing in our data proves them. No rigs guessed.',
  },
]

/** @typedef {{ stubId: number, structureId: number, name: string, owner?: Owner }} StubRekey */

// GEZ stubs whose structure the directory knows under a real id. `owner` is
// the directory's owner where it names one; where it does not, the stub's
// corporation stays.
/** @type {StubRekey[]} */
export const STUB_REKEYS = [
  {
    stubId: 9000189951672246,
    structureId: 1049854533347,
    name: 'C-J6MT - GEZ - T2 Ship, Comps, Structures',
    owner: DJS_RETIREMENT_FUND,
  },
  {
    stubId: 9000900229567453,
    structureId: 1049995488072,
    name: 'C-J6MT - T2 Repro - T2 React',
    owner: DJS_RETIREMENT_FUND,
  },
  {
    stubId: 9000767787048379,
    structureId: 1046962677420,
    name: 'B-S347 - DO NOT USE GEZ T2 Cap Comp',
    owner: DJS_RETIREMENT_FUND,
  },
  { stubId: 9000605477415137, structureId: 1049958297811, name: 'VBPT-T - GEZ T1 Ship (Supercap)', owner: GSF_LPR },
  { stubId: 9000072336625302, structureId: 1050655886984, name: '3Q-VZA - T1 Ship (Supercap)', owner: GSF_LPR },
  { stubId: 9000313405511892, structureId: 1049971659443, name: '384-IN - GEZ T2 Basic Cap Comps', owner: GSF_LPR },
  { stubId: 9000030153670487, structureId: 1047057353010, name: 'AF0-V5 - DO NOT USE GEZ T1 Ship', owner: GSF_LPR },
  { stubId: 9000951261260453, structureId: 1050655692511, name: 'O-7LAI - GEZ T1 Cap (Supers) Coming Soon' },
]

// Every owner the two lists name, once.
export const owners = () =>
  uniq(reject((o) => o == null, [...map((s) => s.owner, INFERRED_STRUCTURES), ...map((r) => r.owner, STUB_REKEYS)]))

// The ESI shape of a services list.
export const toServiceRows = map((name) => ({ name, state: 'online' }))

// What is wrong with an entry, as sentences; an empty list is a clean table.
// Checked in test/inferredStructures.test.ts, so a typo never reaches the
// importer.
/** @type {(rows: readonly InferredStructure[]) => string[]} */
export const inferredProblems = (rows) =>
  chain((row) => {
    const set = RIG_SET_BY_HULL[row.hull]
    return pipe(
      (ps) => (set ? ps : [...ps, `${row.name}: unknown hull "${row.hull}"`]),
      (ps) =>
        row.rigs.length <= MAX_RIGS ? ps : [...ps, `${row.name}: ${row.rigs.length} rigs, at most ${MAX_RIGS} fit`],
      (ps) => (row.services.length > 0 ? ps : [...ps, `${row.name}: no services`]),
      (ps) => [
        ...ps,
        ...map(
          (svc) => `${row.name}: "${svc}" is not an ESI service name`,
          reject((svc) => SERVICE_NAMES.includes(svc), row.services)
        ),
        ...map(
          (rig) => `${row.name}: "${rig}" is not a ${set} rig`,
          filter((rig) => set != null && !rig.startsWith(`Standup ${set} `), row.rigs)
        ),
      ]
    )([])
  }, rows)
