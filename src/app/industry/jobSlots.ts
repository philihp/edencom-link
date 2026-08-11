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

// A job still holding a slot, from either the character or the corp listing.
// Only the columns the count needs; both views carry them under these names.
type JobRow = {
  job_id: number | string
  activity_id: number | string
  status: string
  end_date: string
}
export type CharacterJobRow = JobRow & { registration_id: string }
export type CorpJobRow = JobRow & { installer_id: number | string }

// Occupied slots per character, folding in corp-owned jobs: a job installed
// from the corp hangar still consumes the *installing character's* personal
// slots, so a character running nothing but corp jobs must not read as idle.
// Corp jobs identify the installer by EVE character id, hence the map back to
// the registration uuid the callers key on; jobs installed by someone who
// isn't one of ours drop out. Both callers pass rows already filtered to
// status active/ready.
export const countJobSlots = ({
  characterJobs = [],
  corpJobs = [],
  registrationByCharacterId,
  now = Date.now(),
}: {
  characterJobs?: CharacterJobRow[]
  corpJobs?: CorpJobRow[]
  registrationByCharacterId: Map<string, string>
  now?: number
}): Map<string, SlotCounts> => {
  const byCharacter = new Map<string, SlotCounts>()
  // job_id is unique game-wide, so a job appearing in both listings counts once.
  const seen = new Set<string>()

  const add = (registrationId: string, job: JobRow) => {
    const family = ACTIVITY_FAMILY[Number(job.activity_id)]
    if (!family || seen.has(String(job.job_id))) return
    seen.add(String(job.job_id))
    const counts = byCharacter.get(registrationId) ?? emptyCounts()
    // A job whose timer elapsed still holds its slot until delivered, even if
    // ESI hasn't flipped its status to 'ready' yet.
    const finished = job.status === 'ready' || new Date(job.end_date).getTime() <= now
    counts[family][finished ? 'finished' : 'running'] += 1
    byCharacter.set(registrationId, counts)
  }

  characterJobs.forEach((j) => add(j.registration_id, j))
  corpJobs.forEach((j) => {
    const registrationId = registrationByCharacterId.get(String(j.installer_id))
    if (registrationId) add(registrationId, j)
  })
  return byCharacter
}
