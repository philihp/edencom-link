// The voice an item speaks its memory in, by what kind of item it is
// (docs/ship-memory.md, "Extension: every singleton" → "The voice,
// generalised"). A ship keeps the accent and register the ship chapter gave
// it; everything else gets a native voice of its own from the chart there:
// modules are droids (a high-slot module a brutish one), a blueprint is a
// clerk whose register is its research, a container is a foreman. The
// acquired accents — a high-slot module taking on its hulls' accents, a ship
// picking up highsec lingo — are PR 8 and PR 9 and are not here.
//
// Keyed on the SDE category id and group name the type loader already
// carries, so this costs no extra read. Pure; no I/O.
import { type Voice, voiceOf } from './accent.ts'
import { GENERIC_REGISTER, type Register, registerOf } from './register.ts'

export type ItemKind = 'ship' | 'blueprint' | 'module' | 'container' | 'item'

export const SHIP_CATEGORY_ID = 6
export const BLUEPRINT_CATEGORY_ID = 9
export const MODULE_CATEGORY_ID = 7
// CCP files cargo and secure containers under Celestial, beside planets and
// wrecks; the group name is what says "container".
export const CELESTIAL_CATEGORY_ID = 2

export const kindOf = (type: { categoryID: number | null; groupName: string | null }): ItemKind => {
  switch (type.categoryID) {
    case SHIP_CATEGORY_ID:
      return 'ship'
    case BLUEPRINT_CATEGORY_ID:
      return 'blueprint'
    case MODULE_CATEGORY_ID:
      return 'module'
    case CELESTIAL_CATEGORY_ID:
      return /container/i.test(type.groupName ?? '') ? 'container' : 'item'
    default:
      return 'item'
  }
}

// A module fitted to a high slot: the weapons, miners and remote repairers
// that acquire their hulls' accents.
export const isHighSlot = (flag: string | null | undefined): boolean => /^HiSlot\d$/.test(flag ?? '')

export type NativeVoice = {
  kind: ItemKind
  accent: string
  // Where the accent was placed from: the chart's row for a ship, the kind
  // for everything else.
  origin: string
  placed_by: Voice['from'] | 'kind'
  notes: string
  register: string
  register_class: string
}

const DROID = {
  accent: 'A robotic droid with a limited vocabulary',
  notes:
    'Short declaratives. Status words, numbers, slot names. Reports rather than reflects. No accent of its own: it says what it did and how many times.',
}

const THUG = {
  accent: 'A brutish droid, blunt and proud',
  notes:
    'Measures itself in damage dealt or ore pulled. Impatient with time idle in a hangar. Calls the pilot "boss". Takes on the accents of the hulls it has been fitted to the longest, and says so.',
}

const CLERK = {
  accent: 'A patient clerk who counts in runs',
  notes:
    'Keeps a ledger: every run, every pilot who ever put it in a slot, every level of research as a promotion. Dry, exact, quietly proud of its numbers. Never guesses at a count it was not there for.',
}

const FOREMAN = {
  accent: 'A warehouse foreman',
  notes: 'Talks about what passed through and who left it there. Knows the weight of everything. Tidy by habit.',
}

export type Research = { me: number | null; te: number | null }

// A blueprint's register is its research: a pristine original is a novice, a
// fully researched one has seen everything.
export const blueprintRegister = (research: Research | null): Register => {
  const me = research?.me ?? 0
  const te = research?.te ?? 0
  if (me >= 10 && te >= 20) return { label: 'Fully researched', register: 'Has seen everything; counts in runs' }
  if (me === 0 && te === 0) return { label: 'Unresearched', register: 'A novice; eager to be put to work' }
  return { label: 'Mid-research', register: 'Proud of each level earned; knows the next is coming' }
}

export type NativeVoiceInput = {
  kind: ItemKind
  factionId: number | null
  raceId: number | null
  groupName: string | null
  // The slot the module sits in now, for the thug's register.
  flag?: string | null
  research?: Research | null
}

export const nativeVoiceOf = (input: NativeVoiceInput): NativeVoice => {
  switch (input.kind) {
    case 'ship': {
      const voice = voiceOf({ factionId: input.factionId, raceId: input.raceId })
      const register = registerOf(input.groupName)
      return {
        kind: 'ship',
        accent: voice.accent,
        origin: voice.label,
        placed_by: voice.from,
        notes: voice.notes,
        register: register.register,
        register_class: register.label,
      }
    }
    case 'blueprint': {
      const register = blueprintRegister(input.research ?? null)
      return {
        kind: 'blueprint',
        ...CLERK,
        origin: 'Blueprint',
        placed_by: 'kind',
        register: register.register,
        register_class: register.label,
      }
    }
    case 'module': {
      const high = isHighSlot(input.flag)
      return {
        kind: 'module',
        ...(high ? THUG : DROID),
        origin: high ? 'High-slot module' : 'Module',
        placed_by: 'kind',
        register: high ? 'A thug; swaggers' : 'A droid; reports',
        register_class: input.groupName ?? 'Module',
      }
    }
    case 'container':
      return {
        kind: 'container',
        ...FOREMAN,
        origin: 'Container',
        placed_by: 'kind',
        register: 'Steady; has seen a lot of cargo',
        register_class: input.groupName ?? 'Container',
      }
    default:
      return {
        kind: 'item',
        ...DROID,
        origin: input.groupName ?? 'Item',
        placed_by: 'kind',
        register: GENERIC_REGISTER.register,
        register_class: input.groupName ?? GENERIC_REGISTER.label,
      }
  }
}
