// SDE category ids that the app branches on. Stable ids from CCP's Static Data
// Export, so they're constants rather than a lookup.
//
// Lives here rather than beside any one caller because three of them are in
// layers that must not import from each other: the MCP tools (which re-export
// it), /asset/search, and the appraisal line builder — which is unit-tested and
// so can pull in no I/O at all.

// Blueprints: BPOs, BPCs and reaction formulas alike. Asset search excludes them
// by default, and an appraisal never prices them — an asset row carries no way
// to tell an original from a worthless copy.
export const BLUEPRINT_CATEGORY_ID = 9

// Ancient Relics: the Sleeper salvage tiers (Intact / Malfunctioning / Wrecked
// Armor Nanobots, Power Cores, Hull Sections and friends). Like blueprints,
// these have their own artwork on the image server and no "icon" at all — see
// iconVariation() in src/app/typeIcon.tsx.
export const ANCIENT_RELIC_CATEGORY_ID = 34
