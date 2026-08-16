// AUTO-GENERATED — do not edit by hand.
//
// One `'use step'` function per SDE file, so each ingest slice shows up in
// Vercel's Workflows observability under its own name (`ingest_<stem>`) instead
// of a wall of identical `ingestSlice` rows. Workflow step names are baked from
// the function name at build time (the runtime also uses them for replay-
// divergence detection), so distinct names require distinct source functions —
// hence this generated roster rather than a single parameterized step.
//
// The list is the JSONL entry set of CCP's SDE export, captured statically (see
// scripts/genSdeIngestSteps.mjs to regenerate against the current build). Files
// CCP adds later that aren't in this roster still ingest — sdeMirrorWorkflow
// falls back to the generic `ingestSlice` step for any stem not found here.
//
// Roster captured from SDE build 3466501 (101 files).

export type SdeFile = {
  entry: string
  stem: string
  method: number
  compressedSize: number
  localOffset: number
}

export type IngestSliceStep = (zipUrl: string, file: SdeFile, build: number, startLine: number) => Promise<number>

// The step body, shared by every per-stem step. Lazy-imports the job module
// (its top-level supabase client needs env vars absent at build time), so the
// per-stem functions below stay one-liners whose only real difference is the
// name the workflow compiler reads off them.
const slice: IngestSliceStep = async (zipUrl, file, build, startLine) => {
  const { ingestEntrySlice } = await import('@/jobs/sdeMirror.js')
  return ingestEntrySlice(zipUrl, file, build, startLine)
}

async function ingest_accounting_entry_types(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_agent_types(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_agents_in_space(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_ancestries(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_applied_proximity_effects(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_archetypes(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_bloodlines(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_blueprints(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_categories(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_certificates(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_character_attributes(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_character_titles(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_clone_grades(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_compressible_types(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_contraband_types(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_control_tower_resources(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_corporation_activities(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_corporation_role_groups(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_corporation_roles(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dbuff_collections(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dogma_attribute_categories(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dogma_attributes(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dogma_effects(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dogma_units(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dungeons(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_dynamic_item_attributes(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_epic_arcs(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_expert_systems(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_factions(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_fighter_abilities(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_fighter_abilities_by_type(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_freelance_job_schemas(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_graphic_material_sets(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_graphics(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_groups(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_icons(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_industry_activities(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_industry_assembly_lines(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_industry_installation_types(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_industry_modifier_sources(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_industry_target_filters(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_landmarks(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_link_with_ship(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_asteroid_belts(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_constellations(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_moons(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_planets(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_regions(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_secondary_suns(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_solar_systems(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_stargates(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_map_stars(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_market_groups(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_masteries(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_mercenary_tactical_operations(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_meta_groups(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_metenox_moon_drill(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_military_campaign_objectives(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_military_campaigns(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_missions(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_notification_types(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_npc_characters(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_npc_corporation_divisions(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_npc_corporations(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_npc_stations(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_planet_resources(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_planet_schematics(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_proximity_trap(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_races(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_school_map(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_schools(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_ship_tree_elements(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_ship_tree_factions(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_ship_tree_groups(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skill_plans(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skin_licenses(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skin_materials(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_component_categories(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_component_point_values(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_component_rarities(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_components(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_slot_categories(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_slot_configurations(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_slot_names(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_slots(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_slots_to_materials(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skinr_tier_thresholds(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_skins(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_sovereignty_upgrades(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_station_operations(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_station_services(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_station_standings_restrictions(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_system_dbuff_emitters(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_system_wide_effects(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_translation_languages(
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number
): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_type_bonus(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_type_dogma(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_type_elements(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_type_lists(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_type_materials(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

async function ingest_types(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}

// Stem → its named ingest step. sdeMirrorWorkflow looks a file's stem up here
// and falls back to the generic `ingestSlice` for anything not listed.
export const INGEST_STEPS: Record<string, IngestSliceStep> = {
  accounting_entry_types: ingest_accounting_entry_types,
  agent_types: ingest_agent_types,
  agents_in_space: ingest_agents_in_space,
  ancestries: ingest_ancestries,
  applied_proximity_effects: ingest_applied_proximity_effects,
  archetypes: ingest_archetypes,
  bloodlines: ingest_bloodlines,
  blueprints: ingest_blueprints,
  categories: ingest_categories,
  certificates: ingest_certificates,
  character_attributes: ingest_character_attributes,
  character_titles: ingest_character_titles,
  clone_grades: ingest_clone_grades,
  compressible_types: ingest_compressible_types,
  contraband_types: ingest_contraband_types,
  control_tower_resources: ingest_control_tower_resources,
  corporation_activities: ingest_corporation_activities,
  corporation_role_groups: ingest_corporation_role_groups,
  corporation_roles: ingest_corporation_roles,
  dbuff_collections: ingest_dbuff_collections,
  dogma_attribute_categories: ingest_dogma_attribute_categories,
  dogma_attributes: ingest_dogma_attributes,
  dogma_effects: ingest_dogma_effects,
  dogma_units: ingest_dogma_units,
  dungeons: ingest_dungeons,
  dynamic_item_attributes: ingest_dynamic_item_attributes,
  epic_arcs: ingest_epic_arcs,
  expert_systems: ingest_expert_systems,
  factions: ingest_factions,
  fighter_abilities: ingest_fighter_abilities,
  fighter_abilities_by_type: ingest_fighter_abilities_by_type,
  freelance_job_schemas: ingest_freelance_job_schemas,
  graphic_material_sets: ingest_graphic_material_sets,
  graphics: ingest_graphics,
  groups: ingest_groups,
  icons: ingest_icons,
  industry_activities: ingest_industry_activities,
  industry_assembly_lines: ingest_industry_assembly_lines,
  industry_installation_types: ingest_industry_installation_types,
  industry_modifier_sources: ingest_industry_modifier_sources,
  industry_target_filters: ingest_industry_target_filters,
  landmarks: ingest_landmarks,
  link_with_ship: ingest_link_with_ship,
  map_asteroid_belts: ingest_map_asteroid_belts,
  map_constellations: ingest_map_constellations,
  map_moons: ingest_map_moons,
  map_planets: ingest_map_planets,
  map_regions: ingest_map_regions,
  map_secondary_suns: ingest_map_secondary_suns,
  map_solar_systems: ingest_map_solar_systems,
  map_stargates: ingest_map_stargates,
  map_stars: ingest_map_stars,
  market_groups: ingest_market_groups,
  masteries: ingest_masteries,
  mercenary_tactical_operations: ingest_mercenary_tactical_operations,
  meta_groups: ingest_meta_groups,
  metenox_moon_drill: ingest_metenox_moon_drill,
  military_campaign_objectives: ingest_military_campaign_objectives,
  military_campaigns: ingest_military_campaigns,
  missions: ingest_missions,
  notification_types: ingest_notification_types,
  npc_characters: ingest_npc_characters,
  npc_corporation_divisions: ingest_npc_corporation_divisions,
  npc_corporations: ingest_npc_corporations,
  npc_stations: ingest_npc_stations,
  planet_resources: ingest_planet_resources,
  planet_schematics: ingest_planet_schematics,
  proximity_trap: ingest_proximity_trap,
  races: ingest_races,
  school_map: ingest_school_map,
  schools: ingest_schools,
  ship_tree_elements: ingest_ship_tree_elements,
  ship_tree_factions: ingest_ship_tree_factions,
  ship_tree_groups: ingest_ship_tree_groups,
  skill_plans: ingest_skill_plans,
  skin_licenses: ingest_skin_licenses,
  skin_materials: ingest_skin_materials,
  skinr_component_categories: ingest_skinr_component_categories,
  skinr_component_point_values: ingest_skinr_component_point_values,
  skinr_component_rarities: ingest_skinr_component_rarities,
  skinr_components: ingest_skinr_components,
  skinr_slot_categories: ingest_skinr_slot_categories,
  skinr_slot_configurations: ingest_skinr_slot_configurations,
  skinr_slot_names: ingest_skinr_slot_names,
  skinr_slots: ingest_skinr_slots,
  skinr_slots_to_materials: ingest_skinr_slots_to_materials,
  skinr_tier_thresholds: ingest_skinr_tier_thresholds,
  skins: ingest_skins,
  sovereignty_upgrades: ingest_sovereignty_upgrades,
  station_operations: ingest_station_operations,
  station_services: ingest_station_services,
  station_standings_restrictions: ingest_station_standings_restrictions,
  system_dbuff_emitters: ingest_system_dbuff_emitters,
  system_wide_effects: ingest_system_wide_effects,
  translation_languages: ingest_translation_languages,
  type_bonus: ingest_type_bonus,
  type_dogma: ingest_type_dogma,
  type_elements: ingest_type_elements,
  type_lists: ingest_type_lists,
  type_materials: ingest_type_materials,
  types: ingest_types,
}
