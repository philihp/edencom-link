// Industry job slots: how many parallel jobs of each family a character can run,
// and which activities consume which family's slots. Shared by the character
// list's slot bubbles (/character) and the MCP list_job_slots tool, which answer
// the same question from the same two tables (character_skill + the industry-job
// views) and must not drift apart.

export type SlotFamily = 'manufacturing' | 'research' | 'reaction'

export const SLOT_FAMILIES: SlotFamily[] = ['manufacturing', 'research', 'reaction']

// ESI activity_id → slot family. Science jobs (TE/ME research, copying,
// reverse engineering, invention) all occupy research slots.
export const ACTIVITY_FAMILY: Record<number, SlotFamily> = {
  1: 'manufacturing',
  3: 'research',
  4: 'research',
  5: 'research',
  7: 'research',
  8: 'research',
  9: 'reaction',
}

// The two skills that raise each family's parallel-job slot count. Every
// character has 1 slot for free; each skill adds one slot per level (max 5),
// so the ceiling is 1 + 5 + 5 = 11. active_skill_level (not trained) is what's
// actually usable, matching what the game grants.
export const SLOT_SKILLS: { skillId: number; family: SlotFamily; name: string }[] = [
  { skillId: 3387, family: 'manufacturing', name: 'Mass Production' },
  { skillId: 24625, family: 'manufacturing', name: 'Advanced Mass Production' },
  { skillId: 3406, family: 'research', name: 'Laboratory Operation' },
  { skillId: 24624, family: 'research', name: 'Advanced Laboratory Operation' },
  { skillId: 45748, family: 'reaction', name: 'Mass Reactions' },
  { skillId: 45749, family: 'reaction', name: 'Advanced Mass Reactions' },
]
export const SLOT_SKILL_IDS = SLOT_SKILLS.map((s) => s.skillId)
export const SKILL_FAMILY: Record<number, SlotFamily> = Object.fromEntries(
  SLOT_SKILLS.map((s) => [s.skillId, s.family])
)
export const SKILL_NAME: Record<number, string> = Object.fromEntries(SLOT_SKILLS.map((s) => [s.skillId, s.name]))

// running: jobs still building; finished: jobs whose timer elapsed but that
// still hold their slot until delivered (shown pulsing on /character).
export type FamilyCount = { running: number; finished: number }
export type SlotCounts = Record<SlotFamily, FamilyCount>
export type SlotMax = Record<SlotFamily, number>

export const emptyCounts = (): SlotCounts => ({
  manufacturing: { running: 0, finished: 0 },
  research: { running: 0, finished: 0 },
  reaction: { running: 0, finished: 0 },
})

// One slot per family before any skill is trained.
export const baseSlotMax = (): SlotMax => ({ manufacturing: 1, research: 1, reaction: 1 })
