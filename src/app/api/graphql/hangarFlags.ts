// The HANGAR dimension of the GraphQL filters: which hangar (ESI's
// `location_flag`) a stack sits in — a personal hangar, a Deliveries hangar,
// one of a corporation's seven hangar divisions, or a bay inside a ship.
// Pure, like filters.ts and restock.ts, so test/graphqlHangar.test.ts can
// exercise it under the node test runner.
//
// This is the one filter dimension with NO id form and NO directory behind it:
// `location_flag` is a raw ESI token stored verbatim by the extract jobs
// (`Deliveries`, `CorpSAG3`, `DroneBay`), and there is no table of them to
// resolve a name against. So the catalog below IS the directory — it maps the
// tokens people actually mean to the tokens ESI writes, which is what lets a
// caller say `hangar: "deliveries"` and reach BOTH `Deliveries` (a character's)
// and `CorpDeliveries` (a corporation's) without knowing either token exists.
//
// It follows the schema's singular/plural stance (see filters.ts):
//
//   - `hangar:` is a case-insensitive SUBSTRING search over each flag's token,
//     its label and its aliases, keeping every flag it matched — "deliveries"
//     is both delivery hangars, "corp hangar" is all seven divisions.
//   - `hangars:` is an EXACT list whose entries are whole tokens, labels or
//     aliases, mixed. One entry may still resolve to several flags (the
//     "Deliveries" alias sits on both), the way an exact location name can
//     name two stations.
//
// An entry matching nothing is an ERROR rather than a silently empty result —
// the same reason the other dimensions refuse one. That makes the catalog
// load-bearing: a flag missing from it cannot be filtered by, so a new bay
// worth filtering gets an entry here (and a line in the test).
import { parseRefFilter } from './filters.ts'

export type HangarFlag = {
  // The token as ESI writes it and the extract jobs store it.
  flag: string
  // How the site says it — the /asset Hangar column shows the raw token, but
  // this is what a person filtering means.
  label: string
  // Other whole names that reach this flag. The plural matches these whole,
  // the singular as substrings.
  aliases: readonly string[]
}

// The seven corporation hangar divisions, which are one flag per division
// rather than a division argument. A corp renames them in game; we can't see
// those names, so the number is the handle.
const corpDivisions: HangarFlag[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  flag: `CorpSAG${n}`,
  label: `Corporation hangar division ${n}`,
  aliases: [`corp hangar ${n}`, `corp division ${n}`, `division ${n}`, `sag${n}`],
}))

export const HANGAR_FLAGS: readonly HangarFlag[] = [
  // Station and structure hangars — what a filter almost always means.
  { flag: 'Hangar', label: 'Personal hangar', aliases: ['item hangar', 'personal hangar'] },
  {
    flag: 'Deliveries',
    label: 'Deliveries',
    aliases: ['deliveries', 'delivery hangar', 'personal deliveries', 'character deliveries'],
  },
  {
    flag: 'CorpDeliveries',
    label: 'Corporation deliveries',
    aliases: ['deliveries', 'delivery hangar', 'corp deliveries', 'corporation deliveries'],
  },
  ...corpDivisions,
  { flag: 'AssetSafety', label: 'Asset safety', aliases: ['asset safety wrap'] },
  { flag: 'Impounded', label: 'Impounded', aliases: [] },
  { flag: 'Locked', label: 'Locked (office container)', aliases: [] },
  { flag: 'Unlocked', label: 'Unlocked (office container)', aliases: [] },
  { flag: 'AutoFit', label: 'Auto-fit (inside a container or ship)', aliases: ['container'] },

  // Bays inside a ship or structure. A stack nested in a ship carries these,
  // so they are filterable for the same reason the ship page groups by them.
  { flag: 'Cargo', label: 'Cargo hold', aliases: ['cargo hold', 'cargohold'] },
  { flag: 'DroneBay', label: 'Drone bay', aliases: ['drone bay'] },
  { flag: 'FighterBay', label: 'Fighter bay', aliases: ['fighter bay'] },
  { flag: 'FleetHangar', label: 'Fleet hangar', aliases: ['fleet hangar'] },
  { flag: 'ShipHangar', label: 'Ship maintenance bay', aliases: ['ship hangar', 'ship maintenance bay'] },
  { flag: 'StructureFuel', label: 'Structure fuel bay', aliases: ['fuel bay'] },
  { flag: 'SpecializedFuelBay', label: 'Fuel bay', aliases: ['fuel bay'] },
  { flag: 'SpecializedOreHold', label: 'Ore hold', aliases: ['ore hold'] },
  { flag: 'SpecializedGasHold', label: 'Gas hold', aliases: ['gas hold'] },
  { flag: 'SpecializedMineralHold', label: 'Mineral hold', aliases: ['mineral hold'] },
  { flag: 'SpecializedSalvageHold', label: 'Salvage hold', aliases: ['salvage hold'] },
  { flag: 'SpecializedAmmoHold', label: 'Ammo hold', aliases: ['ammo hold'] },
  { flag: 'SpecializedMaterialBay', label: 'Material bay', aliases: ['material bay'] },
  { flag: 'SpecializedAsteroidHold', label: 'Asteroid hold', aliases: ['asteroid hold'] },
  { flag: 'SpecializedIceHold', label: 'Ice hold', aliases: ['ice hold'] },
  { flag: 'SpecializedCommandCenterHold', label: 'Command center hold', aliases: ['command center hold'] },
  {
    flag: 'SpecializedPlanetaryCommoditiesHold',
    label: 'Planetary commodities hold',
    aliases: ['planetary commodities hold', 'pi hold'],
  },
  { flag: 'SpecializedShipHold', label: 'Ship hold', aliases: ['ship hold'] },
  { flag: 'SpecializedIndustrialShipHold', label: 'Industrial ship hold', aliases: ['industrial ship hold'] },
  { flag: 'SubSystemBay', label: 'Subsystem bay', aliases: ['subsystem bay'] },
  { flag: 'BoosterBay', label: 'Booster bay', aliases: ['booster bay'] },
  { flag: 'QuantumCoreRoom', label: 'Quantum core room', aliases: ['quantum core room', 'core room'] },
  { flag: 'InfrastructureHangar', label: 'Infrastructure hangar', aliases: ['infrastructure hangar'] },
  { flag: 'Wardrobe', label: 'Wardrobe', aliases: [] },
]

// Everything one entry may be typed as, lowercased once.
const termsOf = (entry: HangarFlag): string[] => [entry.flag, entry.label, ...entry.aliases].map((t) => t.toLowerCase())

const available = (): string => HANGAR_FLAGS.map((e) => `${e.flag} (${e.label})`).join(', ')

export type HangarMatch = { ok: true; flags: string[] | null } | { ok: false; message: string }

// The hangar dimension → `location_flag` values to filter on, or null for no
// filter at all. Mirrors matchOwnerFilter's shape so the resolvers treat every
// dimension the same way.
export const matchHangarFilter = (
  hangar: string | null | undefined,
  hangars: readonly string[] | null | undefined,
  // Which pair is being parsed, so a refusal names the arguments the caller
  // actually passed — `hangar`/`hangars` or `excludeHangar`/`excludeHangars`.
  label = 'hangar'
): HangarMatch => {
  const parsed = parseRefFilter(hangar, hangars, label)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const query = parsed.query
  if (query.kind === 'none') return { ok: true, flags: null }

  if (query.kind === 'search') {
    const wanted = query.term.toLowerCase()
    const flags = HANGAR_FLAGS.filter((e) => termsOf(e).some((t) => t.includes(wanted))).map((e) => e.flag)
    if (flags.length === 0) {
      return { ok: false, message: `No hangar matched "${query.term}". Available: ${available()}.` }
    }
    return { ok: true, flags }
  }

  // Exact: a whole token, label or alias. One entry may still reach several
  // flags — "Deliveries" is both a character's and a corporation's.
  const matched = query.entries.map((entry) => {
    const wanted = entry.toLowerCase()
    return { entry, flags: HANGAR_FLAGS.filter((e) => termsOf(e).includes(wanted)).map((e) => e.flag) }
  })
  const unmatched = matched.filter((m) => m.flags.length === 0)
  if (unmatched.length > 0) {
    return {
      ok: false,
      message: `No hangar matched ${unmatched.map((m) => `"${m.entry}"`).join(', ')}. Available: ${available()}.`,
    }
  }
  return { ok: true, flags: [...new Set(matched.flatMap((m) => m.flags))] }
}

// The hangar dimension as the resolvers apply it: which flags to keep, and
// which to drop.
//
// Exclusion is its own pair rather than a negation syntax inside the existing
// one, for the same reason the schema splits singular from plural: a stored
// link is read by someone a year later, and `excludeHangar: "fuel bay"` says
// what it does where a `!` prefix would have to be learned. It resolves
// through exactly the same catalog, so "deliveries" excludes both delivery
// hangars just as it includes both.
//
// The two compose, and composing is the useful case: `hangar: "deliveries",
// excludeHangar: "corp deliveries"` is a character's delivery hangar alone.
// Rather than hand the resolvers two clauses to AND, the overlap is settled
// here — an include list comes back already narrowed, and `exclude` is only
// non-null when there was nothing to narrow.
export type HangarFilters =
  { ok: true; include: string[] | null; exclude: string[] | null } | { ok: false; message: string }

export const resolveHangarFilters = (args: {
  hangar?: string | null
  hangars?: readonly string[] | null
  excludeHangar?: string | null
  excludeHangars?: readonly string[] | null
}): HangarFilters => {
  const included = matchHangarFilter(args.hangar, args.hangars)
  if (!included.ok) return included
  const excluded = matchHangarFilter(args.excludeHangar, args.excludeHangars, 'excludeHangar')
  if (!excluded.ok) return excluded

  if (excluded.flags === null) return { ok: true, include: included.flags, exclude: null }
  if (included.flags === null) return { ok: true, include: null, exclude: excluded.flags }

  // Both given: subtract, and refuse the result that names no hangar at all.
  // An empty result set here is arithmetic the caller got wrong, and a link
  // nobody re-reads for a year would just look broken.
  const dropped = new Set(excluded.flags)
  const remaining = included.flags.filter((flag) => !dropped.has(flag))
  if (remaining.length === 0) {
    return {
      ok: false,
      message: `Every hangar the filter included is also excluded (${included.flags.join(', ')}), so nothing could match.`,
    }
  }
  return { ok: true, include: remaining, exclude: null }
}

// The PostgREST `or=` expression that drops the excluded flags **without
// dropping the rows that have no flag at all**. `location_flag NOT IN (…)` is
// NULL for a null flag, so SQL filters those rows out — but a stack with no
// flag is not in the fuel bay, and excluding the fuel bay must keep it.
//
// The values are interpolated rather than passed as parameters because
// PostgREST's `or` takes one opaque string. That is safe only because they
// come from HANGAR_FLAGS, never from the caller: the catalog is closed, and
// `hangarFlagsAreBareWords` below is the assertion keeping it that way.
export const excludeFlagsExpression = (flags: readonly string[]): string =>
  `location_flag.is.null,location_flag.not.in.(${flags.join(',')})`

// Every catalog token is a bare word, so interpolating one into the `or=`
// expression above cannot end the list or start another clause. Asserted by
// the test rather than trusted, since a future entry is the way this breaks.
export const hangarFlagsAreBareWords = (): boolean => HANGAR_FLAGS.every((e) => /^[A-Za-z0-9]+$/.test(e.flag))
