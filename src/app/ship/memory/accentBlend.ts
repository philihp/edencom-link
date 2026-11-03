// The accents a high-slot module acquires from the hulls it has been fitted
// to (docs/ship-memory.md, "Extension: every singleton" → "Acquired
// accents"). A module is a child of its hull: its version rows carry the
// hull as parent and the slot as flag, so its history is a list of
// attachments straight from those rows. For each hull the days in a HiSlot*
// are summed over every attachment (off and back on the same hull keeps
// counting), hulls of one accent add their days before the cap, and the
// weight is min(1, days / 365): at 1 the module speaks that hull's accent as
// fully as the hull does. Several hulls give several accents.
//
// Computed at recall from the history, never accrued in a table: an item
// asked about for the first time after two years sounds exactly as it would
// have if asked every day. Pure; no I/O. The loader that names the hulls'
// types is loadModule.ts.
import { sortBy } from 'ramda'

import type { Voice } from './accent.ts'
import { isSlotFlag } from './dossier.ts'
import { isHighSlot } from './nativeVoice.ts'

// What the fold needs of a version row of the module itself: the hull it
// sat in (null in a hangar or a container) and the slot.
export type AttachmentVersion = {
  parentId: number | null
  flag: string | null
  isCurrent: boolean
  validFrom: string
  validUntil: string
}

// One stretch fitted to one hull in one slot. `until` is null while it is
// still fitted.
export type Attachment = { hullItemId: number; slot: string; from: string; until: string | null }

// A hull's accent fully acquired after one year attached.
export const ACCENT_FULL_DAYS = 365

export const accentWeight = (days: number): number => Math.min(1, Math.max(0, days) / ACCENT_FULL_DAYS)

const ms = (iso: string): number => new Date(iso).getTime()
const daysBetween = (from: string, until: string): number => Math.max(0, (ms(until) - ms(from)) / 86_400_000)

// Consecutive versions in the same hull and slot collapse into one
// attachment; a version in a hangar, a container or a hold ends it. Any
// slot counts as an attachment (the dossier lists a plate's hulls too); the
// blend below keeps only the high slots.
export const attachments = (versions: AttachmentVersion[]): Attachment[] =>
  sortBy((v) => ms(v.validFrom), versions).reduce<Attachment[]>((acc, v) => {
    if (v.parentId == null || !isSlotFlag(v.flag)) return acc
    const last = acc[acc.length - 1]
    const until = v.isCurrent ? null : v.validUntil
    if (
      last &&
      last.until != null &&
      last.hullItemId === v.parentId &&
      last.slot === v.flag &&
      last.until === v.validFrom
    ) {
      last.until = until
    } else acc.push({ hullItemId: v.parentId, slot: v.flag, from: v.validFrom, until })
    return acc
  }, [])

export const attachmentDays = (a: Attachment, lastSeen: string): number => daysBetween(a.from, a.until ?? lastSeen)

export type HullTenure = { hullItemId: number; attachments: number; days: number; slots: string[]; current: boolean }

// Time per hull over every attachment, longest first.
export const hullTenures = (list: Attachment[], lastSeen: string): HullTenure[] => {
  const byHull = list.reduce<Map<number, HullTenure>>((acc, a) => {
    const t = acc.get(a.hullItemId) ?? { hullItemId: a.hullItemId, attachments: 0, days: 0, slots: [], current: false }
    t.attachments += 1
    t.days += attachmentDays(a, lastSeen)
    if (!t.slots.includes(a.slot)) t.slots.push(a.slot)
    t.current = t.current || a.until == null
    acc.set(a.hullItemId, t)
    return acc
  }, new Map())
  return sortBy((t) => -t.days, [...byHull.values()])
}

export type AcquiredAccent = Voice & {
  // Days in a high slot of hulls with this accent, before the cap.
  days: number
  // min(1, days / 365)
  weight: number
  hulls: number[]
}

// The accents acquired, heaviest first. A hull whose voice the caller
// cannot learn (its type never seen in the record) teaches nothing.
export const accentBlend = (
  list: Attachment[],
  lastSeen: string,
  voiceOfHull: (hullItemId: number) => Voice | null
): AcquiredAccent[] => {
  const high = list.filter((a) => isHighSlot(a.slot))
  const byLabel = high.reduce<Map<string, AcquiredAccent>>((acc, a) => {
    const voice = voiceOfHull(a.hullItemId)
    if (voice == null) return acc
    const entry = acc.get(voice.label) ?? { ...voice, days: 0, weight: 0, hulls: [] }
    entry.days += attachmentDays(a, lastSeen)
    if (!entry.hulls.includes(a.hullItemId)) entry.hulls.push(a.hullItemId)
    acc.set(voice.label, entry)
    return acc
  }, new Map())
  return sortBy(
    (e) => -e.weight,
    [...byLabel.values()].map((e) => ({
      ...e,
      days: Math.round(e.days * 10) / 10,
      weight: Math.round(accentWeight(e.days) * 100) / 100,
    }))
  )
}
