import { SKILL_CATEGORY_ID, type EveData } from './eveData'
import { esfFitToDogmaFit, type EsfFit } from './fit'

// Our own replacement for @eveshipfit/react's DogmaEngineProvider: load the
// WASM engine and wire up the seven data callbacks it reads the SDE through.
//
// Those globals are the engine's real ABI — undocumented, and the thing most
// likely to drift on a version bump. They're all one-line reads of the decoded
// EveData, which is why porting this layer is cheap; ./verify.ts is what tells
// us the contract still holds.

export type CalculationItemAttribute = {
  base_value: number
  value: number
  effects: unknown[]
}

export type CalculationItem = {
  type_id: number
  slot: { type: string; index?: number }
  charge: CalculationItem | undefined
  state: string
  // The engine returns a JS Map keyed by attribute id, not a plain object.
  attributes: Map<number, CalculationItemAttribute>
  effects: unknown[]
}

export type Calculation = {
  hull: CalculationItem
  items: CalculationItem[]
  skills: CalculationItem[]
  char: CalculationItem
  structure: CalculationItem
  target: CalculationItem
}

export type Skills = Record<string, number>

type DogmaEngineModule = {
  init: () => void
  calculate: (fit: unknown, skills: Skills) => Calculation
}

declare global {
  interface Window {
    get_dogma_attributes?: unknown
    get_dogma_attribute?: unknown
    get_dogma_effects?: unknown
    get_dogma_effect?: unknown
    get_type?: unknown
    type_name_to_id?: unknown
    attribute_name_to_id?: unknown
  }
}

// The engine's generated bindings call these synchronously, by name, off
// `window` during calculate() — the reason this whole layer is browser-only.
// Assigned through `globalThis` (the same object in a browser) so a Node
// harness can stand `window` up as an alias and exercise the engine headless.
export const installDataCallbacks = (eveData: EveData): void => {
  const target = globalThis as typeof globalThis & Window

  target.get_dogma_attributes = (typeId: number) => eveData.typeDogma[typeId]?.dogmaAttributes
  target.get_dogma_attribute = (attributeId: number) => eveData.dogmaAttributes[attributeId]
  target.get_dogma_effects = (typeId: number) => eveData.typeDogma[typeId]?.dogmaEffects
  target.get_dogma_effect = (effectId: number) => eveData.dogmaEffects[effectId]
  target.get_type = (typeId: number) => eveData.types[typeId]
  target.type_name_to_id = (name: string) => eveData.typeMapping[name]
  target.attribute_name_to_id = (name: string) => eveData.attributeMapping[name]
}

let engine: Promise<DogmaEngineModule> | null = null

// Dynamic import: the WASM chunk is only fetched on a page that actually
// renders a fit (next.config.mjs already carries the turbopack config this
// package needs).
export const loadDogmaEngine = (): Promise<DogmaEngineModule> => {
  engine ??= import('@eveshipfit/dogma-engine').then((module) => {
    module.init()
    return module as unknown as DogmaEngineModule
  })
  return engine
}

// The engine assumes an *unlisted* skill is trained to level 1 rather than
// untrained, so a baseline has to name every skill explicitly. All-V is the
// standard "what can this hull do" assumption every fitting tool shows, and
// the one the current eveship.fit embed is pinned to.
export const allSkillsAtLevel = (eveData: EveData, level = 5): Skills => {
  const skills: Skills = {}
  for (const typeId in eveData.types) {
    if (eveData.types[typeId].categoryID !== SKILL_CATEGORY_ID) continue
    skills[typeId] = level
  }
  return skills
}

export const calculateFit = (dogma: DogmaEngineModule, fit: EsfFit, skills: Skills): Calculation =>
  dogma.calculate(esfFitToDogmaFit(fit), skills)
