import { readFileSync } from 'fs'
import { join } from 'path'

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { textResult, type ToolResult } from './lib'

export const SKILL_PATH = 'docs/edencom-industry-SKILL.md'
export const GOON_VOICE_PATH = 'docs/goon-voice-SKILL.md'

// Lazy so the readFileSync runs at request time, not at build time. cwd on
// Vercel is the project root (not a monorepo), which is what the tracing
// include in next.config.mjs is declared relative to. One cached text per path.
const cache = new Map<string, string>()
const loadDoc = (path: string): string => {
  const hit = cache.get(path)
  if (hit !== undefined) return hit
  const text = readFileSync(join(process.cwd(), path), 'utf-8')
  cache.set(path, text)
  return text
}
export const loadSkill = (): string => loadDoc(SKILL_PATH)
export const loadGoonVoice = (): string => loadDoc(GOON_VOICE_PATH)

export const registerSkillTools = (server: McpServer): void => {
  server.registerTool(
    'get_skill',
    {
      title: 'EDENCOM Link — industry skill',
      description:
        "The operator's manual for this server: how EVE industry math works (blueprint ME/TE, structure and rig bonuses, security multipliers, invention, job installation cost, facility tax, job profit), where the data comes from (ESI extracts into a database — the tools never call ESI — and the in-game roles corporation data needs), how to read public contracts, wallet journals, fittings and what others share with the user, which tool answers which question, which tools write, and how to use the GraphQL surface (link_schema, run_query, create_link). Call this before your first answer in a session, also when the question looks familiar: it holds this deployment's procedures (gas purchases, fit upgrades, job profit), and an answer from general EVE knowledge has cost a user real ISK.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (): Promise<ToolResult> => textResult(loadSkill())
  )

  server.registerTool(
    'get_goon_voice',
    {
      title: 'EDENCOM Link — goon voice',
      description:
        "How to write like a goon of the Goonswarm Federation: who goons are, the culture, the slang and running jokes, the cast (CEOs, heroes, enemies), the alliance's history from 2005, stock replies, and the hard rules (no slurs, no OPSEC leaks, never speak for leadership, never invent facts). Distilled from the old Goon wiki (2005–2022) plus the alliance forum's recent news: the Asher era from 2022 to 2026, the move to C-J6MT in Insmother, the fall of Pandemic Horde and the war with WinterCo. Call this before you draft an EVE mail reply in a goon's voice, or when the user asks about goon culture or history. Optional: nothing else needs it.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (): Promise<ToolResult> => textResult(loadGoonVoice())
  )
}
