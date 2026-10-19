// Static-game-data exploration tools (docs/mcp-search-exploration.md). These
// read only the nightly-mirrored sde_* tables — no player data, so unlike the
// tools in tools.ts/estateTools.ts they need no bearer-scoped client and return
// no data_refreshed stamp (there is nothing per-user to be stale). The whole
// server still sits behind withMcpAuth, and the mirror is public-read anyway
// (the same rows /esf/* and /sheets/* serve anonymously).
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getBlueprintsForProducts } from '@/sdeBlueprints'
import { getRegionPlanets, getSdePlanets, getSystemPlanets, PLANET_GROUP_ID } from '@/sdePlanets'
import { searchSdeRegions } from '@/sdeRegions'
import { searchSdeSystems } from '@/sdeSystems'
import { getSdeType, getSdeTypeNames, getSdeTypesInGroups, getSdeTypeVariants } from '@/sdeTypes'

import { capNote, MAX_ROWS, resolveOneType, textResult, type ToolResult } from './lib'
import {
  composition,
  formatPlanet,
  matchPlanetTypes,
  MAX_PLANET_IDS,
  rollupSystems,
  roundSecurity,
  type PlanetLike,
} from './planetQuery'
import { formatFamily, parseTypeRef } from './variantQuery'

// Planet type names for a set of planets, resolved in one bulk lookup.
const planetTypeNames = (planets: PlanetLike[]): Promise<Record<number, string>> =>
  getSdeTypeNames(planets.flatMap((p) => (p.typeID == null ? [] : [p.typeID])))

// The planet types CCP currently ships (SDE group 7), for fuzzy planet_type
// resolution. Never a hardcoded list — a new planet type just works.
const resolvePlanetTypes = async (query: string | undefined) =>
  matchPlanetTypes(
    (await getSdeTypesInGroups([PLANET_GROUP_ID])).map((t) => ({ typeID: t.typeID, name: t.name })),
    query
  )

export const registerExploreTools = (server: McpServer): void => {
  server.registerTool(
    'list_planets',
    {
      title: 'List planets',
      description:
        'Planets from static game data, in three modes. Give planet_ids to turn raw planet ids into names ("40099763" → "Q-UVY6 II", with its system, region and security) — mercenary den rows and other raw ids resolve here. Give system for one system\'s planets and its planet-type composition. Give region (optionally with planet_type) to find which systems carry a planet type — "which systems in Metropolis have temperate planets" for den siting, "where are the lava planets" for PI. Exactly one of the three. Coverage is known space; the SDE stores no planet name, so names are derived as "<system> <roman numeral>".',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        planet_ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_PLANET_IDS)
          .optional()
          .describe(`Resolve these planet ids to names, e.g. [40099763]. Up to ${MAX_PLANET_IDS} at a time.`),
        system: z.string().optional().describe('Every planet in this solar system (fuzzy name, e.g. "Q-UVY6")'),
        region: z.string().optional().describe('Planets across this region, rolled up per system (fuzzy name)'),
        planet_type: z
          .string()
          .optional()
          .describe(
            'Only this planet type, e.g. "temperate", "lava", "Planet (Barren)". Applies to the system and region modes.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(`Region mode: how many systems to itemize (default ${MAX_ROWS}). Totals cover everything.`),
      }),
    },
    async ({ planet_ids, system, region, planet_type, limit }): Promise<ToolResult> => {
      const modes = [
        planet_ids ? 'planet_ids' : null,
        system?.trim() ? 'system' : null,
        region?.trim() ? 'region' : null,
      ].filter((m): m is string => m != null)
      if (modes.length !== 1) {
        return textResult(
          modes.length === 0
            ? 'Give exactly one of planet_ids, system, or region.'
            : `Give exactly one of planet_ids, system, or region — got ${modes.join(' and ')}.`
        )
      }

      // ── ids mode: the raw-id resolver ──────────────────────────────────
      if (planet_ids) {
        const byId = await getSdePlanets(planet_ids)
        const found = planet_ids.flatMap((id) => (byId[id] ? [byId[id]] : []))
        const typeNames = await planetTypeNames(found)
        return textResult({
          planets: found.map((p) => formatPlanet(p, typeNames)),
          ...(found.length < planet_ids.length && {
            unresolved: planet_ids.filter((id) => !byId[id]),
            note: 'Unresolved ids are not planets in the mirrored SDE — a planet id is a celestial in the 40,000,000 band (moons, stars and stations have their own bands and are not covered by this tool).',
          }),
        })
      }

      const planetTypes = await resolvePlanetTypes(planet_type)
      if (!planetTypes.ok) return textResult(planetTypes.message)

      // ── system mode: one system in full ────────────────────────────────
      if (system?.trim()) {
        const [best] = await searchSdeSystems(system.trim(), 1)
        if (!best) return textResult(`No solar system matched "${system}".`)
        const planets = await getSystemPlanets([best.systemID])
        if (planets.length === 0) {
          return textResult(`${best.name} has no planets in the mirrored SDE.`)
        }
        const typeNames = await planetTypeNames(planets)
        const matching =
          planetTypes.typeIDs == null
            ? planets
            : planets.filter((p) => p.typeID != null && planetTypes.typeIDs?.includes(p.typeID))
        return textResult({
          system: best.name,
          system_id: best.systemID,
          region: planets[0].regionName,
          security: roundSecurity(best.security),
          total_planets: planets.length,
          // The composition always covers the whole system; planet_type only
          // narrows what gets itemized, so "does it have temperate planets"
          // and "what else is here" are answered by one call.
          composition: composition(planets, typeNames),
          ...(planetTypes.typeIDs != null && {
            planet_type: planetTypes.names.join(', '),
            matching_planets: matching.length,
          }),
          planets: matching.map((p) => formatPlanet(p, typeNames)),
        })
      }

      // ── region mode: which systems carry the type ──────────────────────
      const [bestRegion, ...alsoMatched] = await searchSdeRegions(region!.trim(), 5)
      if (!bestRegion) return textResult(`No region matched "${region}".`)
      // Filtering at the fetch keeps a whole-region read to the rows that were
      // asked about, so the per-system breakdown covers those types only.
      const planets = await getRegionPlanets(bestRegion.regionID, planetTypes.typeIDs ?? undefined)
      if (planets.length === 0) {
        return textResult(
          planetTypes.typeIDs == null
            ? `${bestRegion.name} has no planets in the mirrored SDE.`
            : `No ${planetTypes.names.join(' / ')} planets in ${bestRegion.name}.`
        )
      }
      const typeNames = await planetTypeNames(planets)
      const systems = rollupSystems(planets, typeNames, planetTypes.typeIDs)
      const shown = systems.slice(0, limit ?? MAX_ROWS)
      return textResult({
        region: bestRegion.name,
        region_id: bestRegion.regionID,
        ...(alsoMatched.length > 0 && { also_matched: alsoMatched.map((r) => r.name) }),
        ...(planetTypes.typeIDs != null && { planet_type: planetTypes.names.join(', ') }),
        total_systems: systems.length,
        total_planets: planets.length,
        // Each system's breakdown covers the filtered planet types only when
        // planet_type was given — call the system mode for a full composition.
        systems: shown,
        ...(capNote(systems.length, shown.length, 'systems') && {
          note: capNote(systems.length, shown.length, 'systems'),
        }),
      })
    }
  )
  server.registerTool(
    'module_variants',
    {
      title: 'Module variants and meta levels',
      description:
        'The variant family of an item, from static game data: its Tech I root and every variant of it (named Tech I such as Compact or Enduring, Tech II, Storyline, Faction, Deadspace, Officer, Abyssal), each with its meta level and tier, lowest meta level first, and the blueprint that builds it where one does. Answers "what are the upgrades for a Damage Control II" — the variants above the item asked about are marked higher_meta — and gives the exact names to price with appraise_items and to search for with search_public_contracts (a blueprint name finds BPCs). Give an item name (fuzzy) or a type id. Unpublished variants, which cannot be bought or built, are left out unless include_unpublished is set.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        item: z
          .string()
          .min(1)
          .describe('The module (or any item) by name or type id, e.g. "Damage Control II", "2048"'),
        include_unpublished: z
          .boolean()
          .optional()
          .describe('Also list variants CCP never published — they cannot be bought or built (default false)'),
      }),
    },
    async ({ item, include_unpublished }): Promise<ToolResult> => {
      const ref = parseTypeRef(item)
      const resolved =
        ref.kind === 'id'
          ? await getSdeType(ref.typeID).then((t) =>
              t == null
                ? { ok: false as const, message: `No item type has id ${ref.typeID}.` }
                : { ok: true as const, typeID: t.typeID, name: t.name, alsoMatched: [] as string[] }
            )
          : await resolveOneType(ref.query)
      if (!resolved.ok) return textResult(resolved.message)

      const family = await getSdeTypeVariants(resolved.typeID)
      if (family.length === 0) {
        return textResult(`No variant data for "${resolved.name}" — the SDE mirror may not be ingested yet.`)
      }
      const blueprints = await getBlueprintsForProducts(family.map((v) => v.typeID))
      const blueprintNames = await getSdeTypeNames(Object.values(blueprints).map((b) => b.blueprintTypeID))
      const formatted = formatFamily(family, resolved.typeID, include_unpublished ?? false, (typeID) => {
        const blueprint = blueprints[typeID]
        return blueprint == null ? undefined : blueprintNames[blueprint.blueprintTypeID]
      })

      const notes = [
        ...(formatted.rows.length === 1 ? ['This item has no variants.'] : []),
        ...(formatted.hiddenUnpublished > 0
          ? [`${formatted.hiddenUnpublished} unpublished variant(s) left out; pass include_unpublished to list them.`]
          : []),
        ...(formatted.hasAbyssal
          ? [
              'Abyssal modules are mutated one by one: each item has its own attributes, which neither the market nor a contract listing shows.',
            ]
          : []),
      ]
      return textResult({
        item: resolved.name,
        type_id: String(resolved.typeID),
        ...(resolved.alsoMatched.length > 0 && { also_matched: resolved.alsoMatched }),
        ...(formatted.root != null && { family_root: formatted.root }),
        total_variants: formatted.rows.length,
        higher_meta_variants: formatted.higherMeta,
        variants: formatted.rows,
        ...(notes.length > 0 && { notes }),
      })
    }
  )
}
