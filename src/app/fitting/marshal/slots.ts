// Slot arithmetic for the marshal controls (docs/fitting-marshal.md): how many
// of a character's 500 saved-fitting slots are in use, and which characters
// a marshalled fit can go to. The number the whole feature exists for, so it
// is pure and tested here rather than computed inline in a component.
//
// `used` is as fresh as the character_fitting rows the caller hands in — the
// last extract or the last write, like every count on the site. The write
// path re-checks against EVE's own count before it saves anything
// (restoreFitting), so a stale number here only mis-sorts a picker, never
// overfills a character.
// EVE's cap, restated rather than imported: src/fittingArchive.ts holds the
// canonical FITTING_SLOTS, but it also imports node:crypto for the content
// hash, and this module is reached from client components (the pickers), where
// that import cannot bundle. test/marshalSlots.test.ts pins the two equal.
export const FITTING_SLOTS = 500

export type OwnCharacter = {
  registrationId: string
  // The EVE numeric character id, as a string.
  characterId: string
  name: string | null
}

export type SlotUsage = OwnCharacter & {
  used: number
  free: number
  full: boolean
  // Holds the opt-in write scope, so a save or delete may be asked of it.
  writable: boolean
}

/** One entry per own character, whether or not it has saved any fits. */
export const slotUsage = (
  fittingRows: ReadonlyArray<{ registration_id: string }>,
  characters: ReadonlyArray<OwnCharacter>,
  writableRegistrationIds: ReadonlySet<string>,
  capacity: number = FITTING_SLOTS
): SlotUsage[] => {
  const used = new Map<string, number>()
  fittingRows.forEach((row) => used.set(row.registration_id, (used.get(row.registration_id) ?? 0) + 1))
  return characters.map((c) => {
    const n = used.get(c.registrationId) ?? 0
    return {
      ...c,
      used: n,
      free: Math.max(0, capacity - n),
      full: n >= capacity,
      writable: writableRegistrationIds.has(c.registrationId),
    }
  })
}

export type UnmarshalTarget = SlotUsage & {
  // A full character, or one without the write scope, is listed but cannot be
  // chosen — the picker shows why rather than hiding them.
  disabled: boolean
  reason: 'full' | 'not writable' | null
}

/**
 * The characters a fit can be saved to, emptiest first (then by name, so the
 * order is stable), with `excludeRegistrationId` left out — the transfer
 * picker never offers the character the fit is already on.
 */
export const unmarshalTargets = (usage: ReadonlyArray<SlotUsage>, excludeRegistrationId?: string): UnmarshalTarget[] =>
  usage
    .filter((u) => u.registrationId !== excludeRegistrationId)
    .map((u) => ({
      ...u,
      disabled: u.full || !u.writable,
      reason: u.full ? ('full' as const) : u.writable ? null : ('not writable' as const),
    }))
    .sort((a, b) => b.free - a.free || (a.name ?? '').localeCompare(b.name ?? ''))

/** `Pilot · 487 / 500`, the slot meter's text. */
export const slotMeter = (u: SlotUsage, capacity: number = FITTING_SLOTS): string =>
  `${u.name ?? `Character #${u.characterId}`} · ${u.used} / ${capacity}`

/** The picker's option text: `Pilot · 412 / 500`, with why it cannot be chosen. */
export const targetLabel = (t: UnmarshalTarget, capacity: number = FITTING_SLOTS): string => {
  const base = `${t.name ?? `Character #${t.characterId}`} · ${t.used} / ${capacity}`
  return t.reason === 'full' ? `${base} — full` : t.reason === 'not writable' ? `${base} — no write scope` : base
}
