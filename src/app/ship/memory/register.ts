// How old a ship sounds (docs/ship-memory.md, "Register by hull class"). The
// accent (accent.ts) is where the hull comes from; the register is its size:
// a frigate brags, a battleship is sure of itself, a freighter has seen every
// dock. Keyed on the SDE group name, which is what the type loader already
// carries, so this costs no extra read. A group the chart does not place
// (a new CCP hull line, or an item that is not a ship) reads as the generic
// register rather than nothing. The test pins every register against the
// doc's chart. No I/O.

export type Register = { label: string; register: string }

const SMALL: Register = { label: 'Frigate, destroyer', register: 'Young and eager; brags' }
const MID: Register = { label: 'Cruiser, battlecruiser', register: 'Seasoned; has opinions' }
const BATTLESHIP: Register = { label: 'Battleship', register: 'Grand, slow, sure of itself' }
const HAULER: Register = {
  label: 'Industrial, freighter, jump freighter',
  register: 'A weary teamster who knows every dock',
}
const MINER: Register = { label: 'Mining barge, exhumer, Orca, Rorqual', register: 'Patient; talks about the rock' }
const CAPITAL: Register = {
  label: 'Capital, supercapital',
  register: 'Ancient and ponderous; remembers everything',
}
const TINY: Register = { label: 'Shuttle, corvette, capsule', register: 'Small and earnest' }

export const GENERIC_REGISTER: Register = { label: 'Unplaced', register: 'A working voice of no particular age' }

export const REGISTER_BY_GROUP: Readonly<Record<string, Register>> = {
  Frigate: SMALL,
  'Assault Frigate': SMALL,
  Interceptor: SMALL,
  'Covert Ops': SMALL,
  'Stealth Bomber': SMALL,
  'Electronic Attack Ship': SMALL,
  'Expedition Frigate': SMALL,
  'Logistics Frigate': SMALL,
  Destroyer: SMALL,
  Interdictor: SMALL,
  'Command Destroyer': SMALL,
  'Tactical Destroyer': SMALL,
  Cruiser: MID,
  'Heavy Assault Cruiser': MID,
  Logistics: MID,
  'Force Recon Ship': MID,
  'Combat Recon Ship': MID,
  'Heavy Interdiction Cruiser': MID,
  'Strategic Cruiser': MID,
  'Flag Cruiser': MID,
  'Combat Battlecruiser': MID,
  'Attack Battlecruiser': MID,
  'Command Ship': MID,
  Battleship: BATTLESHIP,
  'Black Ops': BATTLESHIP,
  Marauder: BATTLESHIP,
  // "Hauler" is CCP's current name for the old "Industrial" group.
  Hauler: HAULER,
  Industrial: HAULER,
  'Deep Space Transport': HAULER,
  'Blockade Runner': HAULER,
  Freighter: HAULER,
  'Jump Freighter': HAULER,
  'Mining Barge': MINER,
  Exhumer: MINER,
  'Industrial Command Ship': MINER, // Orca, Porpoise
  'Capital Industrial Ship': MINER, // Rorqual
  Dreadnought: CAPITAL,
  'Lancer Dreadnought': CAPITAL,
  Carrier: CAPITAL,
  'Force Auxiliary': CAPITAL,
  Supercarrier: CAPITAL,
  Titan: CAPITAL,
  Shuttle: TINY,
  Corvette: TINY,
  Capsule: TINY,
}

export const registerOf = (groupName: string | null | undefined): Register =>
  (groupName && REGISTER_BY_GROUP[groupName]) || GENERIC_REGISTER
