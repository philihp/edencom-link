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

// The readout, grouped the way the panel lays it out. Ported from
// @eveshipfit/react's ShipStatistics (MIT) — same attributes, same formatting
// rules, our own grouping and order, which is what stage 2 of
// docs/custom-fit-ui.md set out to own.

export type StatGroup = { label: string; rows: AttributeFormat[] }

export const STAT_GROUPS: StatGroup[] = [
  {
    label: 'Defense',
    rows: [
      { name: 'ehp', label: 'Effective HP', fixed: 0, roundDown: true, unit: 'ehp' },
      { name: 'shieldCapacity', label: 'Shield', fixed: 0, roundDown: true, unit: 'hp' },
      { name: 'armorHP', label: 'Armor', fixed: 0, roundDown: true, unit: 'hp' },
      { name: 'hp', label: 'Structure', fixed: 0, roundDown: true, unit: 'hp' },
    ],
  },
  {
    label: 'Offense',
    rows: [
      { name: 'damagePerSecondWithoutReload', label: 'Damage', fixed: 1, unit: 'dps' },
      { name: 'damagePerSecondWithReload', label: 'Damage with reload', fixed: 1, unit: 'dps' },
      { name: 'damageAlpha', label: 'Alpha strike', fixed: 0, unit: 'hp' },
      { name: 'droneDamagePerSecond', label: 'Drone damage', fixed: 1, unit: 'dps' },
      { name: 'droneBandwidthLoad', label: 'Drone bandwidth used', fixed: 0, unit: 'Mbit/s' },
      { name: 'droneBandwidth', label: 'Drone bandwidth', fixed: 0, unit: 'Mbit/s' },
    ],
  },
  {
    label: 'Capacitor',
    rows: [
      { name: 'capacitorCapacity', label: 'Capacity', fixed: 1, unit: 'GJ' },
      { name: 'rechargeRate', label: 'Recharge', fixed: 2, divideBy: 1000, unit: 's' },
      { name: 'capacitorPeakDelta', label: 'Peak delta', fixed: 1, unit: 'GJ/s' },
      { name: 'capacitorPeakDeltaPercentage', label: 'Peak delta', fixed: 1, unit: '%' },
      { name: 'capacitorDepletesIn', label: 'Depletes in', fixed: 1, unit: 's' },
    ],
  },
  {
    label: 'Navigation',
    rows: [
      { name: 'maxVelocity', label: 'Max velocity', fixed: 1, unit: 'm/s' },
      { name: 'warpSpeedMultiplier', label: 'Warp speed', fixed: 2, unit: 'AU/s' },
      { name: 'alignTime', label: 'Align time', fixed: 2, unit: 's' },
      { name: 'agility', label: 'Inertia modifier', fixed: 4, unit: 'x' },
      { name: 'mass', label: 'Mass', fixed: 2, divideBy: 1000, unit: 't' },
      { name: 'signatureRadius', label: 'Signature radius', fixed: 0, unit: 'm' },
    ],
  },
  {
    label: 'Targeting',
    rows: [
      { name: 'maxTargetRange', label: 'Targeting range', fixed: 2, divideBy: 1000, unit: 'km' },
      { name: 'scanStrength', label: 'Sensor strength', fixed: 2, unit: 'points' },
      { name: 'scanResolution', label: 'Scan resolution', fixed: 0, unit: 'mm' },
      { name: 'maxLockedTargets', label: 'Max locked targets', fixed: 0, unit: 'x' },
    ],
  },
]

// The resist grid: three layers by four damage types, which reads as a table
// rather than as twelve label/value pairs. Hull resonances carry no prefix —
// they *are* the bare attribute names.
export const DAMAGE_TYPES = ['Em', 'Thermal', 'Kinetic', 'Explosive'] as const

export const RESIST_LAYERS: { label: string; prefix: string }[] = [
  { label: 'Shield', prefix: 'shield' },
  { label: 'Armor', prefix: 'armor' },
  { label: 'Structure', prefix: '' },
]

export const resistFormat = (prefix: string, damage: (typeof DAMAGE_TYPES)[number]): AttributeFormat => ({
  name:
    prefix === ''
      ? `${damage.charAt(0).toLowerCase()}${damage.slice(1)}DamageResonance`
      : `${prefix}${damage}DamageResonance`,
  label: `${prefix} ${damage}`,
  fixed: 1,
  isResistance: true,
  unit: '%',
})

// Calibration is the one resource the hull doesn't report a remainder for:
// it's spent by the rigs themselves, each carrying what it costs, so the load
// is summed off the fitted items rather than subtracted from the output.
const calibrationUsed = (eveData: EveData, calculation: Calculation): number => {
  const costId = eveData.attributeMapping['upgradeCost']
  return calculation.items
    .filter((item) => item.slot.type === 'Rig')
    .reduce((total, item) => total + (item.attributes.get(costId)?.value ?? 0), 0)
}

// The three fitting resources the ring's bars draw: how much of the hull's
// output the fit is using. The engine reports what's *left*, so used is the
// subtraction — except calibration, which reports the load directly.
export type FittingResource = { label: string; used: number; total: number; unit: string }

export const fittingResources = (eveData: EveData, calculation: Calculation): FittingResource[] => {
  const value = (name: string) => attributeValue(eveData, calculation, name)
  const cpu = value('cpuOutput')
  const power = value('powerOutput')
  const calibration = value('upgradeCapacity')
  return [
    { label: 'CPU', used: cpu - value('cpuFree'), total: cpu, unit: 'tf' },
    { label: 'Power', used: power - value('powerFree'), total: power, unit: 'MW' },
    // A hull with no rig slots has no calibration to spend, and an empty bar
    // reading 0 / 0 says nothing.
    ...(calibration > 0
      ? [{ label: 'Calibration', used: calibrationUsed(eveData, calculation), total: calibration, unit: '' }]
      : []),
  ]
}

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
