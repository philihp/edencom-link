import type { Calculation } from './dogma'
import type { EveData } from './eveData'

// Reading and formatting attributes out of a Calculation, ported from
// @eveshipfit/react's ShipAttribute + StatisticsProvider (MIT).
//
// Stage 0 only needs enough of this to *compare* against the current viewer,
// so the rules that matter are the ones that change a displayed number: the
// fall back to the attribute's SDE default when the engine didn't produce one,
// resistances as percentages, and the round-down/round-up asymmetry (an EHP of
// 18 519.9 shows as 18 519, a resist of 55.01% shows as 56%).

export type AttributeSource = 'hull' | 'char'

export const attributeValue = (
  eveData: EveData,
  calculation: Calculation,
  name: string,
  source: AttributeSource = 'hull'
): number => {
  const id = eveData.attributeMapping[name]
  if (id === undefined) return 0
  // `||` not `??`, matching upstream: an attribute the engine computed as 0
  // falls back to the SDE default too.
  return calculation[source].attributes.get(id)?.value || eveData.dogmaAttributes[id]?.defaultValue || 0
}

export type AttributeFormat = {
  name: string
  label: string
  fixed: number
  unit?: string
  divideBy?: number
  roundDown?: boolean
  isResistance?: boolean
  source?: AttributeSource
}

export const formatAttribute = (eveData: EveData, calculation: Calculation, format: AttributeFormat): string => {
  let value = attributeValue(eveData, calculation, format.name, format.source ?? 'hull')

  // Resonances are stored as the fraction that gets *through*, and shown as
  // the fraction stopped.
  if (format.isResistance) value = 100 - value * 100
  if (format.divideBy) value /= format.divideBy

  const k = Math.pow(10, format.fixed)
  if (format.isResistance) {
    value -= 1 / k / 10
    value = Math.ceil(value * k) / k
  } else if (format.roundDown) {
    value = Math.floor(value * k) / k
  } else {
    value = Math.round(value * k) / k
  }

  if (Object.is(value, -0)) value = 0
  if (format.isResistance) value = Math.max(value, 0)

  return value.toLocaleString('en', { minimumFractionDigits: format.fixed, maximumFractionDigits: format.fixed })
}

// The readout the current viewer shows, in its order — the checklist the
// stage-0 comparison runs down. Stage 2 replaces this with a laid-out panel;
// here it's deliberately a flat list of label/value pairs.
export const HEADLINE: AttributeFormat[] = [
  { name: 'ehp', label: 'EHP', fixed: 0, roundDown: true, unit: 'ehp' },
  { name: 'shieldCapacity', label: 'Shield', fixed: 0, roundDown: true, unit: 'hp' },
  { name: 'armorHP', label: 'Armor', fixed: 0, roundDown: true, unit: 'hp' },
  { name: 'hp', label: 'Hull', fixed: 0, roundDown: true, unit: 'hp' },
  { name: 'shieldEmDamageResonance', label: 'Shield EM resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'shieldThermalDamageResonance', label: 'Shield thermal resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'shieldKineticDamageResonance', label: 'Shield kinetic resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'shieldExplosiveDamageResonance', label: 'Shield explosive resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'armorEmDamageResonance', label: 'Armor EM resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'armorThermalDamageResonance', label: 'Armor thermal resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'armorKineticDamageResonance', label: 'Armor kinetic resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'armorExplosiveDamageResonance', label: 'Armor explosive resist', fixed: 1, isResistance: true, unit: '%' },
  { name: 'damagePerSecondWithoutReload', label: 'DPS', fixed: 1, unit: 'dps' },
  { name: 'damagePerSecondWithReload', label: 'DPS (with reload)', fixed: 1, unit: 'dps' },
  { name: 'damageAlpha', label: 'Alpha', fixed: 0, unit: 'HP' },
  { name: 'droneDamagePerSecond', label: 'Drone DPS', fixed: 1, unit: 'dps' },
  { name: 'droneBandwidthLoad', label: 'Drone bandwidth used', fixed: 0 },
  { name: 'droneBandwidth', label: 'Drone bandwidth', fixed: 0 },
  { name: 'capacitorCapacity', label: 'Capacitor', fixed: 1, unit: 'GJ' },
  { name: 'rechargeRate', label: 'Capacitor recharge', fixed: 2, divideBy: 1000, unit: 's' },
  { name: 'capacitorPeakDelta', label: 'Capacitor delta', fixed: 1, unit: 'GJ/s' },
  { name: 'capacitorPeakDeltaPercentage', label: 'Capacitor delta', fixed: 1, unit: '%' },
  { name: 'capacitorDepletesIn', label: 'Capacitor depletes in', fixed: 1, unit: 's' },
  { name: 'maxVelocity', label: 'Max velocity', fixed: 1, unit: 'm/s' },
  { name: 'warpSpeedMultiplier', label: 'Warp speed', fixed: 2, unit: 'AU/s' },
  { name: 'alignTime', label: 'Align time', fixed: 2, unit: 's' },
  { name: 'agility', label: 'Inertia modifier', fixed: 4, unit: 'x' },
  { name: 'mass', label: 'Mass', fixed: 2, divideBy: 1000, unit: 't' },
  { name: 'maxTargetRange', label: 'Targeting range', fixed: 2, divideBy: 1000, unit: 'km' },
  { name: 'scanStrength', label: 'Sensor strength', fixed: 2, unit: 'points' },
  { name: 'scanResolution', label: 'Scan resolution', fixed: 0, unit: 'mm' },
  { name: 'signatureRadius', label: 'Signature radius', fixed: 0, unit: 'm' },
  { name: 'maxLockedTargets', label: 'Max locked targets', fixed: 0, unit: 'x' },
  { name: 'cpuFree', label: 'CPU free', fixed: 2, unit: 'tf' },
  { name: 'cpuOutput', label: 'CPU total', fixed: 2, unit: 'tf' },
  { name: 'powerFree', label: 'Powergrid free', fixed: 2, unit: 'MW' },
  { name: 'powerOutput', label: 'Powergrid total', fixed: 2, unit: 'MW' },
]

export type SlotCounts = Record<'High' | 'Medium' | 'Low' | 'SubSystem' | 'Rig' | 'Launcher' | 'Turret', number>

// [hull attribute, per-item modifier attribute]. A T3's slots come entirely
// from its subsystems' modifiers, so reading only the hull reports zero slots
// on the one hull family where the count is most interesting.
const SLOT_ATTRIBUTES: [keyof SlotCounts, string, string | null][] = [
  ['High', 'hiSlots', 'hiSlotModifier'],
  ['Medium', 'medSlots', 'medSlotModifier'],
  ['Low', 'lowSlots', 'lowSlotModifier'],
  ['SubSystem', 'maxSubSystems', null],
  ['Rig', 'rigSlots', null],
  ['Launcher', 'launcherSlotsLeft', 'launcherHardPointModifier'],
  ['Turret', 'turretSlotsLeft', 'turretHardPointModifier'],
]

export const calculateSlots = (eveData: EveData, calculation: Calculation): SlotCounts => {
  const slots = { High: 0, Medium: 0, Low: 0, SubSystem: 0, Rig: 0, Launcher: 0, Turret: 0 }

  for (const [slot, hullAttribute, itemAttribute] of SLOT_ATTRIBUTES) {
    const id = eveData.attributeMapping[hullAttribute]
    slots[slot] += calculation.hull.attributes.get(id)?.value ?? 0
    if (itemAttribute === null) continue
    const modifierId = eveData.attributeMapping[itemAttribute]
    for (const item of calculation.items) slots[slot] += item.attributes.get(modifierId)?.value ?? 0
  }

  // EVE went from five subsystems to four; the attribute never followed.
  if (slots.SubSystem === 5) slots.SubSystem = 4

  return slots
}
