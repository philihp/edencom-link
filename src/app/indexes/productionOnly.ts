import { includes, reject } from 'ramda'

import type { Activity } from '../structure/industryIndex'

// The Indexes page's "manufacturing & reactions only" toggle: research,
// copying and invention columns hidden. Remembered in a plain (not httpOnly)
// cookie so the server render already draws the chosen columns.
export const PRODUCTION_ONLY_COOKIE = 'indexes_production_only'

// 400 days — the lifetime @supabase/ssr gives the session cookie, and the
// longest a browser will honour (RFC 6265bis caps Max-Age there).
export const PRODUCTION_ONLY_MAX_AGE = 400 * 24 * 60 * 60

const SCIENCE: Activity[] = ['researching_material_efficiency', 'researching_time_efficiency', 'copying', 'invention']

export const parseProductionOnly = (raw: string | undefined): boolean => raw === '1'

export const visibleColumns = (columns: Activity[], productionOnly: boolean): Activity[] =>
  productionOnly ? reject((a: Activity) => includes(a, SCIENCE), columns) : columns
