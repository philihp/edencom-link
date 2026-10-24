import { readFileSync } from 'fs'
import { join } from 'path'

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { textResult, type ToolResult } from './lib'

export const SKILL_PATH = 'docs/edencom-industry-SKILL.md'

// Lazy so the readFileSync runs at request time, not at build time. cwd on
// Vercel is the project root (not a monorepo), which is what the tracing
// include in next.config.mjs is declared relative to.
let skill: string | undefined
export const loadSkill = (): string => {
  if (!skill) skill = readFileSync(join(process.cwd(), SKILL_PATH), 'utf-8')
  return skill
}

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
}
