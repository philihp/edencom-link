// The accent a ship speaks its memory in (docs/ship-memory.md, "Accent"):
// where the hull comes from, read from the SDE as its faction first, then its
// race, then a plain spacer's voice. The faction has to come first: a Gila is
// Guristas by faction and Caldari by race, and it should sound like the pirate
// it is. A hull's name is never used to guess either.
//
// Keyed on the SDE's factionID and raceID rather than their names, so the
// loader (PR 3) reads two columns of sde_published_type and nothing else, and
// a CCP rename cannot silently drop a hull to neutral. The chart itself is
// the owner's draft, to edit here and in the doc together. No I/O.

export type Accent = {
  // The chart's row, as the doc names it.
  label: string
  accent: string
  notes: string
}

// Which rule placed the hull: its faction, its race, or neither.
export type Voice = Accent & { from: 'faction' | 'race' | 'neutral' }

const AMARR: Accent = {
  label: 'Amarr Empire',
  accent: 'Received Pronunciation with a cathedral cadence',
  notes:
    'Speaks of duty and the Scriptures. Addresses the pilot as "Holder". Latinate words, long sentences. Signs off "Amarr victor."',
}
const AMMATAR: Accent = {
  label: 'Ammatar Mandate',
  accent: 'RP learned late, and overcorrected',
  notes: "A convert's zeal. More Amarr than the Amarr. Bristles at the sight of Minmatar hulls.",
}
const KHANID: Accent = {
  label: 'Khanid Kingdom',
  accent: 'Courtly and legalistic',
  notes:
    'Speaks to the pilot as though petitioning a court. Keeps the paperwork for every jump. Cousin to the Amarr, and proud of the distance.',
}
const CALDARI: Accent = {
  label: 'Caldari State',
  accent: 'Finnish-inflected English, flat and clipped',
  notes: 'Talks like a quarterly report. Says "we", meaning the corporation. Measures every trip in efficiency.',
}
const MORDU: Accent = {
  label: "Caldari Navy / Mordu's Legion",
  accent: 'Texas drill sergeant',
  notes: 'Short orders. "Squared away." Respects a full ammo bay.',
}
const GALLENTE: Accent = {
  label: 'Gallente Federation',
  accent: 'French',
  notes: 'Romantic, argumentative, a little vain about its own lines. Liberty, wine and good docking lights.',
}
const SERPENTIS: Accent = {
  label: 'Serpentis',
  accent: 'Riviera-smooth; a pharmaceutical sales rep',
  notes: 'Charming, deniable. Never says what was in the cargo hold.',
}
const MINMATAR: Accent = {
  label: 'Minmatar Republic',
  accent: 'Scots burr',
  notes: 'Rust and pride. "It\'s held together, hasn\'t it?" Talks about the tribes, the Elders, and freedom.',
}
const THUKKER: Accent = {
  label: 'Thukker Tribe',
  accent: 'Sing-song caravan lilt',
  notes: 'A nomad. Measures life in stops, not systems. Never likes staying docked long.',
}
const ANGEL: Accent = {
  label: 'Angel Cartel',
  accent: 'Cockney wide boy',
  notes: 'Always working an angle. Fast, flashy, keeps a second set of books.',
}
const GURISTAS: Accent = {
  label: 'Guristas Pirates',
  accent: 'Australian larrikin',
  notes: 'Jokes at the worst moments. Proud of its drones. Calls the pilot "mate".',
}
const BLOOD_RAIDER: Accent = {
  label: 'The Blood Raider Covenant',
  accent: 'Whispered gothic, horror-film Transylvanian',
  notes: 'Devout in a way that makes the crew uneasy. Talks about blood and harvest.',
}
const SANSHA: Accent = {
  label: "Sansha's Nation",
  accent: 'A chorus; a flat newsreader voice spoken a thousand times',
  notes: 'Always "we". Calm, total and certain.',
}
const SISTERS: Accent = {
  label: 'Servant Sisters of EVE',
  accent: 'Soft Irish',
  notes: 'A nurse who has seen too much. Gentle, tired and kind. Counts the survivors.',
}
const SOCT: Accent = {
  label: 'The Society of Conscious Thought',
  accent: 'Unplaceable and unhurried',
  notes: 'Monastic. Answers a question with a better question.',
}
const CONCORD: Accent = {
  label: 'CONCORD Assembly',
  accent: 'Mid-Atlantic newsreel announcer',
  notes: 'Bureaucratic. Cites regulations. Everything is "pursuant to".',
}
const ORE: Accent = {
  label: 'ORE',
  accent: 'Yorkshire pit village',
  notes: 'Blue-collar, patient, dry. Respects the rock. Counts in m³.',
}
const JOVE: Accent = {
  label: 'Jove Empire',
  accent: 'No accent at all',
  notes: 'Every word exact. Faintly too old. Slightly disappointed in everyone.',
}
const TRIGLAVIAN: Accent = {
  label: 'Triglavian Collective',
  accent: 'Slavic, liturgical',
  notes: 'Speaks in threes. "Clade", "Flow", "Proving". Every trip a trial.',
}
const EDENCOM: Accent = {
  label: 'EDENCOM',
  accent: 'Military radio brevity',
  notes: '"Copy." "Wilco." Status reports. Remembers the invasion. This site\'s own namesake, so give it its due.',
}
const DEATHLESS: Accent = {
  label: 'Deathless Circle',
  accent: 'Gravel and gallows humour',
  notes: "A convict's voice. Has seen Zarzakh. Laughs at fines.",
}
const DRIFTERS: Accent = {
  label: 'Drifters / Sleepers',
  accent: 'Speaks seldom, in fragments',
  notes: 'One word, a long silence, then three more.',
}

export const NEUTRAL: Accent = {
  label: 'Neutral',
  accent: 'Plain spacer',
  notes: 'An unplaceable working voice, for anything the SDE does not place.',
}

// sde_factions ids, with the SDE's own name beside each. Every hull carries
// one, not just pirate and navy hulls: a Rifter is 500002. Navy Issue hulls
// carry their empire's (the Caldari Navy Hookbill is 500001), so the chart's
// "Caldari Navy" half is reached through Mordu's Legion alone. The Syndicate,
// EverMore, Unknown, Rogue Drones and the Association for Interdisciplinary
// Research have no row and fall through to the race.
export const FACTION_ACCENTS: ReadonlyMap<number, Accent> = new Map([
  [500001, CALDARI], // Caldari State
  [500002, MINMATAR], // Minmatar Republic
  [500003, AMARR], // Amarr Empire
  [500004, GALLENTE], // Gallente Federation
  [500005, JOVE], // Jove Empire
  [500006, CONCORD], // CONCORD Assembly
  [500007, AMMATAR], // Ammatar Mandate
  [500008, KHANID], // Khanid Kingdom
  [500010, GURISTAS], // Guristas Pirates
  [500011, ANGEL], // Angel Cartel
  [500012, BLOOD_RAIDER], // Blood Raider Covenant
  [500014, ORE], // ORE
  [500015, THUKKER], // Thukker Tribe
  [500016, SISTERS], // Servant Sisters of EVE
  [500017, SOCT], // The Society of Conscious Thought
  [500018, MORDU], // Mordu's Legion Command
  [500019, SANSHA], // Sansha's Nation
  [500020, SERPENTIS], // Serpentis
  [500024, DRIFTERS], // Drifters
  [500026, TRIGLAVIAN], // Triglavian Collective
  [500027, EDENCOM], // EDENCOM
  [500029, DEATHLESS], // Deathless Circle
])

// sde_races ids, for a hull with no faction or one the chart has no row for.
// Pirate (32), Rogue Drones (134) and Upwell (168) have none: neutral.
export const RACE_ACCENTS: ReadonlyMap<number, Accent> = new Map([
  [1, CALDARI], // Caldari
  [2, MINMATAR], // Minmatar
  [4, AMARR], // Amarr
  [8, GALLENTE], // Gallente
  [16, JOVE], // Jove
  [64, DRIFTERS], // Sleepers
  [128, ORE], // ORE
  [135, TRIGLAVIAN], // Triglavian
])

type Origin = { factionId: number | null; raceId: number | null }

export const voiceOf = ({ factionId, raceId }: Origin): Voice => {
  const byFaction = factionId == null ? undefined : FACTION_ACCENTS.get(factionId)
  if (byFaction) return { ...byFaction, from: 'faction' }
  const byRace = raceId == null ? undefined : RACE_ACCENTS.get(raceId)
  if (byRace) return { ...byRace, from: 'race' }
  return { ...NEUTRAL, from: 'neutral' }
}
