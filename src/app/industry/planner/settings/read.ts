import type { SupabaseClient } from '@supabase/supabase-js'

import { fromRow, type PlannerSettings, type SettingsRow } from './settings'

export const SETTINGS_COLUMNS = 'overbuild, minimum_margin, market_fees, scc_tax, home_market, haul_import, haul_export'

// The account's planner settings, or the defaults when it has saved none.
// RLS pins planner_settings to the caller, so no user_id filter is needed.
export const fetchPlannerSettings = async (supabase: SupabaseClient): Promise<PlannerSettings> => {
  const { data } = await supabase.from('planner_settings').select(SETTINGS_COLUMNS).maybeSingle<SettingsRow>()
  return fromRow(data)
}
