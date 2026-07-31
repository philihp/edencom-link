// MCP tools for industry planning: system cost indices (the job-cost half that
// blueprint_for_product's material modelling leaves out), free vs occupied job
// slots per character, and which Upwell rigs actually bonus a given blueprint.
// Same rules as tools.ts — RLS-scoped bearer client, DB and mirrored SDE only,
// never ESI.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'

import { fetchType, resolveProductTypeID } from '@/app/blueprint/api'
import { rigsForProduct } from '@/app/blueprint/rigs'
import {
  ACTIVITY_FAMILY,
  baseSlotMax,
  emptyCounts,
  SKILL_FAMILY,
  SKILL_NAME,
  SLOT_FAMILIES,
  SLOT_SKILL_IDS,
  type SlotCounts,
  type SlotMax,
} from '@/app/industry/jobSlots'
import {
  fetchLatestSystemIndexes,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  type Activity,
} from '@/app/structure/industryIndex'
import { getSdeSystemNames, searchSdeSystems } from '@/sdeSystems'
import { getSdeTypeNames, searchSdeTypesAll } from '@/sdeTypes'
import { createBearerClient } from '@/utils/supabase/bearer'

import { dataFreshness, fetchOwnerContext, textResult } from './lib'

type SupabaseClient = ReturnType<typeof createBearerClient>

const clientFor = (extra: { authInfo?: AuthInfo }): SupabaseClient | null =>
  extra.authInfo?.token ? createBearerClient(extra.authInfo.token) : null

// The systems the caller has a reason to care about when they don't name one:
// everywhere they hold a structure, plus everything on their /indexes watchlist.
// Those are exactly the systems the industry-systems job snapshots indices for.
const relevantSystemIds = async (supabase: SupabaseClient): Promise<number[]> => {
  const [{ data: structures }, { data: watched }] = await Promise.all([
    supabase.from('corp_structure').select('system_id'),
    supabase.from('watched_system').select('system_id'),
  ])
  return [
    ...new Set(
      [
        ...((structures ?? []) as Array<{ system_id: number | string }>),
        ...((watched ?? []) as Array<{ system_id: number | string }>),
      ].map((r) => Number(r.system_id))
    ),
  ]
}

export const registerIndustryTools = (server: McpServer): void => {
  server.registerTool(
    'industry_cost_indices',
    {
      title: 'Industry cost indices',
      description:
        'Manufacturing, research, copying, invention, and reaction cost indices for solar systems — the multiplier that sets a job\'s installation fee. Answers "where is manufacturing cheapest right now" or "what is the reaction index in this system". With no system named, covers every system the user holds a structure in or watches on the /indexes page.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        system: z
          .string()
          .optional()
          .describe(
            'A solar system name (or substring), e.g. "EKPB-3". Omit to cover your structures and watched systems.'
          ),
        activity: z
          .enum([
            'manufacturing',
            'reaction',
            'researching_material_efficiency',
            'researching_time_efficiency',
            'copying',
            'invention',
          ])
          .optional()
          .describe('Only this activity (default: all of them)'),
      },
    },
    async ({ system, activity }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      let systemIds: number[]
      let scope: string
      if (system?.trim()) {
        const matches = await searchSdeSystems(system, 10)
        if (matches.length === 0) return textResult(`No solar system matched "${system}".`)
        systemIds = matches.map((m) => m.systemID)
        scope = matches.length === 1 ? matches[0].name : `${matches.length} systems matching "${system}"`
      } else {
        systemIds = await relevantSystemIds(supabase)
        scope = 'your structures and watched systems'
        if (systemIds.length === 0) {
          return textResult(
            'No systems to report on: you hold no monitored structures and watch no systems. Name a system explicitly, or add one on the /indexes page.'
          )
        }
      }

      const [indexes, systemNames] = await Promise.all([
        fetchLatestSystemIndexes(supabase, systemIds),
        getSdeSystemNames(systemIds),
      ])

      const rows = systemIds
        .map((systemId) => {
          const byActivity = indexes.get(systemId)
          const activities = (activity ? [activity as Activity] : (Object.keys(INDEX_ACTIVITY_LABELS) as Activity[]))
            .filter((a) => byActivity?.get(a) != null)
            .map((a) => ({
              activity: INDEX_ACTIVITY_LABELS[a],
              cost_index: byActivity!.get(a)!,
              displayed: formatIndex(byActivity!.get(a)!),
            }))
          return { system: systemNames[systemId] ?? `System #${systemId}`, indices: activities }
        })
        .filter((r) => r.indices.length > 0)
        .sort((a, b) =>
          // When one activity was asked for, rank cheapest first — that's the
          // "where should I build this" question. Otherwise sort by name.
          activity ? a.indices[0].cost_index - b.indices[0].cost_index : a.system.localeCompare(b.system)
        )

      if (rows.length === 0) {
        return textResult(
          `No cost indices recorded for ${scope}. The industry-systems job only snapshots systems holding a structure or on someone's watchlist.`
        )
      }

      return textResult({
        scope,
        ...(activity && { activity: INDEX_ACTIVITY_LABELS[activity as Activity], sorted: 'cheapest first' }),
        systems: rows,
        note: 'A cost index scales the job installation fee, not material use. Material efficiency comes from blueprint ME, structure role bonus, and rigs — see blueprint_for_product.',
        data_refreshed: await dataFreshness(supabase, ['industry-systems']),
      })
    }
  )

  server.registerTool(
    'list_job_slots',
    {
      title: 'List industry job slots',
      description:
        'Per character, how many manufacturing, research, and reaction job slots are occupied and how many are free — the actionable half that list_industry_jobs leaves out. Slot ceilings come from the trained slot skills (Mass Production, Laboratory Operation, Mass Reactions and their Advanced variants). Answers "who can start another job" or "how many research slots do I have spare".',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        free_only: z.boolean().optional().describe('Only characters with at least one free slot (default false)'),
      },
    },
    async ({ free_only }, extra) => {
      const supabase = clientFor(extra)
      if (!supabase) return textResult('Missing bearer token.')

      const owners = await fetchOwnerContext(supabase)
      const [{ data: jobRows }, { data: skillRows }] = await Promise.all([
        // Jobs holding a slot: running, or finished but not yet delivered.
        supabase
          .from('character_industry_job')
          .select('registration_id, activity_id, status, end_date')
          .in('status', ['active', 'ready']),
        supabase
          .from('character_skill')
          .select('registration_id, skill_id, active_skill_level')
          .in('skill_id', SLOT_SKILL_IDS),
      ])

      const now = Date.now()
      const counts = new Map<string, SlotCounts>()
      ;(
        (jobRows ?? []) as Array<{ registration_id: string; activity_id: number; status: string; end_date: string }>
      ).forEach((j) => {
        const family = ACTIVITY_FAMILY[Number(j.activity_id)]
        if (!family) return
        const entry = counts.get(j.registration_id) ?? emptyCounts()
        // A job whose timer elapsed still holds its slot until delivered, even
        // if ESI hasn't flipped its status yet (cf. /character).
        const finished = j.status === 'ready' || new Date(j.end_date).getTime() <= now
        entry[family][finished ? 'finished' : 'running'] += 1
        counts.set(j.registration_id, entry)
      })

      const maxes = new Map<string, SlotMax>()
      const skillLevels = new Map<string, Map<number, number>>()
      ;((skillRows ?? []) as Array<{ registration_id: string; skill_id: number; active_skill_level: number }>).forEach(
        (r) => {
          const family = SKILL_FAMILY[Number(r.skill_id)]
          if (!family) return
          const max = maxes.get(r.registration_id) ?? baseSlotMax()
          max[family] += Number(r.active_skill_level) || 0
          maxes.set(r.registration_id, max)
          const levels = skillLevels.get(r.registration_id) ?? new Map<number, number>()
          levels.set(Number(r.skill_id), Number(r.active_skill_level) || 0)
          skillLevels.set(r.registration_id, levels)
        }
      )

      const characters = owners.characterIds
        .map((characterId) => {
          const used = counts.get(characterId) ?? emptyCounts()
          const max = maxes.get(characterId) ?? baseSlotMax()
          const levels = skillLevels.get(characterId)
          const families = SLOT_FAMILIES.map((family) => {
            const occupied = used[family].running + used[family].finished
            return {
              family,
              slots: max[family],
              running: used[family].running,
              ready_to_deliver: used[family].finished,
              // Never report negative headroom: if skill data lags reality, the
              // occupied count wins (same guard the /character bubbles use).
              free: Math.max(0, max[family] - occupied),
            }
          })
          return {
            character: owners.nameById.get(characterId) ?? characterId,
            slots: families,
            total_free: families.reduce((sum, f) => sum + f.free, 0),
            // Absent skill rows mean the character hasn't shared the Skills
            // scope — the ceilings then fall back to the untrained baseline of
            // one slot each, which understates a trained character.
            ...(levels == null && { skills_unknown: true }),
            ...(levels != null && {
              slot_skills: Object.fromEntries([...levels].map(([id, lvl]) => [SKILL_NAME[id] ?? `Skill #${id}`, lvl])),
            }),
          }
        })
        .filter((c) => !free_only || c.total_free > 0)
        .sort((a, b) => b.total_free - a.total_free || a.character.localeCompare(b.character))

      return textResult({
        characters,
        total_free_slots: characters.reduce((sum, c) => sum + c.total_free, 0),
        note: "Corporation-installed jobs occupy the installing character's slots, so they are counted here too when that character is one of yours.",
        data_refreshed: await dataFreshness(supabase, ['character-industry-jobs', 'character-status']),
      })
    }
  )

  server.registerTool(
    'rigs_for_blueprint',
    {
      title: 'Rigs that bonus a blueprint',
      description:
        'Which Upwell structure rigs give a material bonus to building a given item — a rig only affects products in the groups its filter covers, so a Ship Manufacturing rig does nothing for components. Answers "which rig helps me build Nitrogen Fuel Blocks". Pass a structure_id to see which of those rigs is actually fitted there; that is the same test blueprint_for_product applies when pricing a build in a structure.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        item: z
          .string()
          .min(1)
          .describe('The item being built, or its blueprint, e.g. "Nightmare", "Nitrogen Fuel Block Blueprint"'),
        structure_id: z
          .string()
          .optional()
          .describe('One of your monitored Upwell structures (from list_structures) to check the fitted rigs against'),
      },
    },
    async ({ item, structure_id }, extra) => {
      const matches = await searchSdeTypesAll(item.trim())
      if (matches.length === 0) return textResult(`No item type matched "${item}".`)
      const best = matches[0]

      // Rig applicability is decided by the *product's* group/category, so a
      // blueprint name is resolved through to what it builds first.
      const asProduct = await fetchType(best.typeID)
      const productTypeID = asProduct?.name?.endsWith('Blueprint')
        ? await resolveProductTypeID(asProduct.name)
        : best.typeID
      const product = productTypeID != null ? await fetchType(productTypeID) : null

      if (product?.groupID == null) {
        return textResult(
          `Couldn't work out what "${best.name}" builds, so there's no product group to match rigs against.`
        )
      }

      const rigTypeIDs = rigsForProduct(product.groupID, product.categoryID ?? -1)
      if (rigTypeIDs.length === 0) {
        return textResult({
          product: product.name ?? best.name,
          rigs: [],
          note: 'No Upwell rig gives this product a material bonus.',
        })
      }

      const rigNames = await getSdeTypeNames(rigTypeIDs)
      const rigs = rigTypeIDs
        .map((id) => ({ typeID: id, name: rigNames[id] ?? `Type #${id}` }))
        .sort((a, b) => a.name.localeCompare(b.name))

      // Optionally intersect with what's actually bolted onto a structure.
      let fitted: { structure: string; applicable: string[]; other_rigs: string[] } | null = null
      if (structure_id) {
        const supabase = clientFor(extra)
        if (!supabase) return textResult('Missing bearer token.')
        const { data: structure } = await supabase
          .from('corp_structure')
          .select('structure_id, name')
          .eq('structure_id', structure_id)
          .maybeSingle()
        if (!structure) {
          return textResult(`Structure ${structure_id} isn't among the structures you monitor (corp_structure).`)
        }
        const { data: rigRows } = await supabase
          .from('corp_structure_rig')
          .select('type_id')
          .eq('structure_id', structure_id)
        const fittedIds = ((rigRows ?? []) as Array<{ type_id: number | string }>).map((r) => Number(r.type_id))
        const fittedNames = await getSdeTypeNames(fittedIds)
        const applicableIds = new Set(rigTypeIDs)
        fitted = {
          structure: (structure.name as string) ?? `Structure #${structure_id}`,
          applicable: fittedIds.filter((id) => applicableIds.has(id)).map((id) => fittedNames[id] ?? `Type #${id}`),
          other_rigs: fittedIds.filter((id) => !applicableIds.has(id)).map((id) => fittedNames[id] ?? `Type #${id}`),
        }
      }

      return textResult({
        product: product.name ?? best.name,
        ...(product.name != null &&
          best.name !== product.name && {
            note: `Interpreted "${item}" as ${best.name}, which builds ${product.name}.`,
          }),
        rigs_that_bonus_it: rigs.map((r) => r.name),
        ...(fitted != null && {
          at_structure: fitted.structure,
          fitted_and_applicable: fitted.applicable,
          fitted_but_not_applicable: fitted.other_rigs,
          ...(fitted.applicable.length === 0 && {
            structure_note:
              'None of the rigs fitted to this structure bonus this product, so a build there gets no rig discount.',
          }),
        }),
      })
    }
  )
}
