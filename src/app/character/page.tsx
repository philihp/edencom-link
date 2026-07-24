import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ascend, range, reduce, sort, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { formatBisk } from '../isk'
import { fetchSystemNames, fetchSystemPaths } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import { register } from './actions'
import { requiredScopes } from './scopes'
import { getEnabledScopes } from './userScopes'
import styles from './character.module.css'

type SlotFamily = 'manufacturing' | 'research' | 'reaction'

const SLOT_ROWS: { family: SlotFamily; label: string }[] = [
  { family: 'manufacturing', label: 'Manufacturing' },
  { family: 'research', label: 'Research' },
  { family: 'reaction', label: 'Reactions' },
]

// ESI activity_id → slot family. Science jobs (TE/ME research, copying,
// reverse engineering, invention) all occupy research slots.
const ACTIVITY_FAMILY: Record<number, SlotFamily> = {
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
const SLOT_SKILLS: { skillId: number; family: SlotFamily; name: string }[] = [
  { skillId: 3387, family: 'manufacturing', name: 'Mass Production' },
  { skillId: 24625, family: 'manufacturing', name: 'Advanced Mass Production' },
  { skillId: 3406, family: 'research', name: 'Laboratory Operation' },
  { skillId: 24624, family: 'research', name: 'Advanced Laboratory Operation' },
  { skillId: 45748, family: 'reaction', name: 'Mass Reactions' },
  { skillId: 45749, family: 'reaction', name: 'Advanced Mass Reactions' },
]
const SLOT_SKILL_IDS = SLOT_SKILLS.map((s) => s.skillId)
const SKILL_FAMILY: Record<number, SlotFamily> = Object.fromEntries(SLOT_SKILLS.map((s) => [s.skillId, s.family]))

// running: jobs still building; finished: jobs whose timer elapsed but that
// still hold their slot until delivered (shown pulsing).
type FamilyCount = { running: number; finished: number }
type SlotCounts = Record<SlotFamily, FamilyCount>
type SlotMax = Record<SlotFamily, number>

const emptyCounts = (): SlotCounts => ({
  manufacturing: { running: 0, finished: 0 },
  research: { running: 0, finished: 0 },
  reaction: { running: 0, finished: 0 },
})
// One slot per family before any skill is trained.
const baseSlotMax = (): SlotMax => ({ manufacturing: 1, research: 1, reaction: 1 })

const JobSlots = ({ counts, max }: { counts: SlotCounts; max: SlotMax }) => (
  <div className={styles.slots}>
    {SLOT_ROWS.map(({ family, label }) => {
      const { running, finished } = counts[family]
      // Never hide a job: if skill data lags behind reality, widen the row to
      // fit every occupied slot rather than clip it.
      const slotCount = Math.max(max[family], running + finished)
      return (
        <div
          key={family}
          className={`${styles.slotRow} ${styles[family]}`}
          title={`${label}: ${running} running, ${finished} ready of ${max[family]} slot${max[family] === 1 ? '' : 's'}`}
        >
          {range(0, slotCount).map((i) => {
            if (i < running) return <span key={i} className={`${styles.slot} ${styles.slotFilled}`} />
            if (i < running + finished) return <span key={i} className={`${styles.slot} ${styles.slotReady}`} />
            return <span key={i} className={styles.slot} />
          })}
        </div>
      )
    })}
  </div>
)

const CharacterPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters, status, statusText, error } = await supabase.from('registration').select()

  const { data: wallets } = await supabase
    .from('character_wallet')
    .select('character_id, balance, recorded_at')
    .order('recorded_at', { ascending: false })

  const latestBalance = reduce(
    (acc, w) => (acc.has(w.character_id) ? acc : acc.set(w.character_id, w.balance)),
    new Map<string, string>(),
    wallets ?? []
  )

  const { data: locations } = await supabase.from('character_location').select('character_id, solar_system_id')
  const systemNames = await fetchSystemNames((locations ?? []).map((l) => Number(l.solar_system_id)))
  const locationSystem = new Map(
    (locations ?? []).map((l) => [
      l.character_id as string,
      systemNames[Number(l.solar_system_id)] ?? `System #${l.solar_system_id}`,
    ])
  )

  const { data: clones } = await supabase.from('character_clone').select('character_id, system_id')
  const cloneSystemPaths = await fetchSystemPaths((clones ?? []).map((c) => Number(c.system_id)))
  const cloneSystemsByCharacter = reduce(
    (acc, c) => {
      const system =
        c.system_id != null ? (cloneSystemPaths[Number(c.system_id)] ?? `System #${c.system_id}`) : 'Unknown'
      const existing = acc.get(c.character_id as string) ?? []
      acc.set(c.character_id as string, uniq([...existing, system]))
      return acc
    },
    new Map<string, string[]>(),
    clones ?? []
  )
  const cloneSystems = new Map(
    [...cloneSystemsByCharacter.entries()].map(([characterId, systems]) => [
      characterId,
      sort(
        ascend((s: string) => s),
        systems
      ),
    ])
  )

  const { data: implantRows } = await supabase.from('character_implant').select('character_id, type_ids')
  const implantTypeNames = await fetchTypeNames((implantRows ?? []).flatMap((r) => (r.type_ids ?? []).map(Number)))
  const implantsByCharacter = new Map(
    (implantRows ?? []).map((r) => [
      r.character_id as string,
      (r.type_ids ?? []).map((id: number) => implantTypeNames[id] ?? `Type #${id}`),
    ])
  )

  const { data: shipRows } = await supabase
    .from('character_ship')
    .select('character_id, ship_item_id, ship_type_id, ship_name')
  const shipTypeNames = await fetchTypeNames((shipRows ?? []).map((r) => Number(r.ship_type_id)))
  const currentShip = new Map(
    (shipRows ?? []).map((r) => {
      const typeName = shipTypeNames[Number(r.ship_type_id)] ?? `Type #${r.ship_type_id}`
      return [
        r.character_id as string,
        {
          itemId: String(r.ship_item_id),
          label: r.ship_name && r.ship_name !== typeName ? `${r.ship_name} (${typeName})` : typeName,
        },
      ]
    })
  )

  // Jobs that still hold a slot: running (status 'active') or ready to deliver
  // (status 'ready'). A job whose timer elapsed but that ESI still reports as
  // 'active' is treated as ready too, so the pulsing "deliver me" state doesn't
  // wait on ESI flipping the status.
  const nowMs = Date.now()
  const { data: industryJobs } = await supabase
    .from('character_industry_job')
    .select('character_id, activity_id, status, end_date')
    .in('status', ['active', 'ready'])
  const jobSlotCounts = reduce(
    (acc, j) => {
      const family = ACTIVITY_FAMILY[Number(j.activity_id)]
      if (family) {
        const counts = acc.get(j.character_id as string) ?? emptyCounts()
        const finished = j.status === 'ready' || new Date(j.end_date as string).getTime() <= nowMs
        counts[family][finished ? 'finished' : 'running'] += 1
        acc.set(j.character_id as string, counts)
      }
      return acc
    },
    new Map<string, SlotCounts>(),
    industryJobs ?? []
  )

  // Per-character slot ceilings, derived from the two skills behind each family.
  const { data: skillRows } = await supabase
    .from('character_skill')
    .select('character_id, skill_id, active_skill_level')
    .in('skill_id', SLOT_SKILL_IDS)
  const slotMax = reduce(
    (acc, r) => {
      const family = SKILL_FAMILY[Number(r.skill_id)]
      if (family) {
        const max = acc.get(r.character_id as string) ?? baseSlotMax()
        max[family] += Number(r.active_skill_level) || 0
        acc.set(r.character_id as string, max)
      }
      return acc
    },
    new Map<string, SlotMax>(),
    skillRows ?? []
  )

  // If the player has turned off every optional ESI scope, characters they add
  // grant nothing beyond identification, so almost no features will work.
  const enabledScopes = await getEnabledScopes(supabase, data.user.id)
  const hasNoOptionalScopes = enabledScopes.every((scope) => requiredScopes.includes(scope))

  return (
    <>
      <h1>Characters</h1>
      {hasNoOptionalScopes && (
        <div className={styles.warning} role="alert">
          <strong className={styles.warningTitle}>Limited access selected</strong>
          <p className={styles.warningBody}>
            You haven&apos;t enabled any ESI permissions, so characters you add will only be identified — no wallet,
            assets, industry, market, or structure data can be tracked. Choose what to share in{' '}
            <Link href="/settings/grants">settings</Link>.
          </p>
        </div>
      )}
      <ul className={styles.grid}>
        {characters?.map((c) => (
          <li key={`character-${c.id}`} className={styles.tile}>
            {c.character_id ? (
              <img
                className={styles.avatar}
                src={`https://images.evetech.net/characters/${c.character_id}/portrait?size=128`}
                alt={c.name}
              />
            ) : (
              <div className={styles.avatar} aria-hidden="true" />
            )}
            <div className={styles.body}>
              <div className={styles.name}>{c.name}</div>
              {/* Only show the job-slot bubbles for characters who have shared their
                  skills — slotMax has an entry only when character_skill rows exist,
                  so without the scope we don't guess a capacity, we show nothing. */}
              {slotMax.has(c.id) && (
                <JobSlots counts={jobSlotCounts.get(c.id) ?? emptyCounts()} max={slotMax.get(c.id)!} />
              )}
              <div className={styles.meta}>
                <span className={styles.metaLabel}>ISK:</span>
                {latestBalance.has(c.id) ? formatBisk(latestBalance.get(c.id)!) : '—'}
              </div>
              <div className={styles.meta}>
                <span className={styles.metaLabel}>Location:</span>
                {locationSystem.get(c.id) ?? '—'}
              </div>
              <div className={styles.meta}>
                <span className={styles.metaLabel}>Ship:</span>
                {currentShip.has(c.id) ? (
                  <Link href={`/ship/${currentShip.get(c.id)!.itemId}`}>{currentShip.get(c.id)!.label}</Link>
                ) : (
                  '—'
                )}
              </div>
              {(cloneSystems.get(c.id)?.length ?? 0) > 0 && (
                <div className={styles.metaBlock}>
                  <span className={styles.metaLabel}>Clone systems:</span>
                  <ul className={`${styles.bulletList} ${styles.cloneList}`}>
                    {cloneSystems.get(c.id)!.map((system) => (
                      <li key={system}>{system}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(implantsByCharacter.get(c.id)?.length ?? 0) > 0 && (
                <div className={styles.metaBlock}>
                  <span className={styles.metaLabel}>Implants:</span>
                  <ul className={styles.bulletList}>
                    {implantsByCharacter.get(c.id)!.map((name: string, i: number) => (
                      <li key={i}>{name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <>
          <strong>
            {status}: {statusText}
          </strong>
          <br />
          <em>
            {error.code}: {error.message}
          </em>
          <pre>{JSON.stringify(error, undefined, 2)}</pre>
        </>
      )}
      <form className={styles.actions}>
        <button formAction={register}>Add Character</button>
      </form>
    </>
  )
}
export default CharacterPage
