// The column sets the api_token CSV routes serve, factored out of the route
// files so the link drop-in templates (src/app/link/templates.ts) can be
// tested for exact header parity against them (test/linkTemplates.test.ts) —
// route files may only export Next's route fields, so the arrays live here.
// Each matches its Postgres function's json_build_object in schema.sql; order
// is the CSV column order.

export const CHARACTER_ASSET_COLUMNS = [
  'is_blueprint_copy',
  'is_singleton',
  'item_id',
  'location_flag',
  'location_id',
  'location_type',
  'quantity',
  'type_id',
  'character_name',
] as const

export const CHARACTER_BLUEPRINT_COLUMNS = [
  'item_id',
  'location_flag',
  'location_id',
  'material_efficiency',
  'quantity',
  'runs',
  'time_efficiency',
  'type_id',
  'character_name',
] as const

export const CHARACTER_ORDER_COLUMNS = [
  'duration',
  'escrow',
  'is_buy_order',
  'is_corporation',
  'issued',
  'location_id',
  'min_volume',
  'order_id',
  'price',
  'range',
  'region_id',
  'type_id',
  'volume_remain',
  'volume_total',
  'character_name',
] as const

export const CHARACTER_JOB_COLUMNS = [
  'activity_id',
  'blueprint_id',
  'blueprint_location_id',
  'blueprint_type_id',
  'completed_character_id',
  'completed_date',
  'cost',
  'duration',
  'end_date',
  'facility_id',
  'installer_id',
  'job_id',
  'licensed_runs',
  'output_location_id',
  'pause_date',
  'probability',
  'product_type_id',
  'runs',
  'start_date',
  'station_id',
  'status',
  'successful_runs',
  'character_name',
  'blueprint_type_name',
  'product_type_name',
] as const

export const CORP_ASSET_COLUMNS = [
  'item_id',
  'corporation_id',
  'type_id',
  'location_id',
  'location_flag',
  'location_type',
  'quantity',
  'is_singleton',
  'is_blueprint_copy',
] as const

export const CORP_BLUEPRINT_COLUMNS = [
  'item_id',
  'corporation_id',
  'location_flag',
  'location_id',
  'material_efficiency',
  'quantity',
  'runs',
  'time_efficiency',
  'type_id',
] as const

export const CORP_JOB_COLUMNS = [
  'activity_id',
  'blueprint_id',
  'blueprint_location_id',
  'blueprint_type_id',
  'completed_character_id',
  'completed_date',
  'corporation_id',
  'cost',
  'duration',
  'end_date',
  'facility_id',
  'installer_id',
  'job_id',
  'licensed_runs',
  'output_location_id',
  'pause_date',
  'probability',
  'product_type_id',
  'runs',
  'start_date',
  'station_id',
  'status',
  'successful_runs',
  'blueprint_type_name',
  'product_type_name',
] as const
