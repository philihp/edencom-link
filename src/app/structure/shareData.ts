import type { SupabaseClient } from '@supabase/supabase-js'
import { map } from 'ramda'

import { signShare, tokenSalt } from '@/shareToken'

import { fetchShareAudiences, type ShareDialogData } from '../asset/shareData'
import { directorOf, fetchDirectorships } from './directors'
import { type StructureShareRow, structureShareState } from './shareRows'

// Server-side fetch of what the structure Share dialog and the /structure
// alliance toggle need on first paint (docs/sharing-layer/12-structure-share.md,
// "UI"). Everything reads on the caller's cookie client: the share rows a
// director can see are exactly the ones the "Directors manage structure
// shares" policy shows them.

export type StructureShareDialogData = ShareDialogData & { corporationName: string }

const SHARE_COLUMNS = 'id, corporation_id, structure_id, corporation_ids, alliance_ids, secret, tenants, seeded_default'

// The signed ?share= param for a row with a link, or null — signing is
// server-only (the secret and TOKEN_SALT never reach the client), and a
// deployment without its salt just shows the link unavailable.
const signedParam = (row: StructureShareRow): string | null => {
  if (!row.secret) return null
  try {
    return signShare(row.id, row.secret, tokenSalt())
  } catch {
    return null
  }
}

// Null unless the caller DIRECTS the corporation that owns the structure —
// RLS visibility is not ownership (an alliance-mate or tenant reads the row
// too), and a plain member is not offered what they cannot save.
export const fetchStructureShareDialogData = async (
  supabase: SupabaseClient,
  structureId: string
): Promise<StructureShareDialogData | null> => {
  const { data: structure } = await supabase
    .from('corp_structure')
    .select('structure_id, corporation_id')
    .eq('structure_id', structureId)
    .maybeSingle<{ structure_id: number | string; corporation_id: number | string }>()
  if (!structure) return null
  const corporationId = Number(structure.corporation_id)
  const director = await directorOf(supabase, corporationId)
  if (!director) return null

  const { data: regs } = await supabase.from('registration').select('id, corporation_id')
  const [{ corporations, alliances }, { data: shareRow }, { data: corp }] = await Promise.all([
    fetchShareAudiences(supabase, (regs ?? []) as Array<{ id: string; corporation_id: number | string | null }>),
    supabase
      .from('corp_structure_share')
      .select(SHARE_COLUMNS)
      .eq('corporation_id', corporationId)
      .eq('structure_id', structureId)
      .maybeSingle<StructureShareRow>(),
    supabase
      .from('corporation')
      .select('name')
      .eq('corporation_id', corporationId)
      .maybeSingle<{ name: string | null }>(),
  ])

  return {
    share: shareRow ? structureShareState(shareRow, signedParam(shareRow)) : null,
    corporations,
    alliances,
    hasLegacyToken: false,
    corporationName: corp?.name ?? `Corporation #${corporationId}`,
  }
}

// One toggle per corporation the caller directs that is in an alliance: the
// corporation-wide (null-subject) row, on or off. "On" is any null-subject row
// naming that alliance — the seeded default, or the toggle's own re-insert.
export type AllianceShareDefault = {
  corporationId: number
  corporationName: string
  allianceId: number
  allianceName: string
  enabled: boolean
}

export const fetchAllianceShareDefaults = async (supabase: SupabaseClient): Promise<AllianceShareDefault[]> => {
  const directorships = await fetchDirectorships(supabase)
  if (directorships.length === 0) return []
  const corpIds = map((d) => d.corporationId, directorships)

  const [{ data: corps }, { data: rows }] = await Promise.all([
    supabase.from('corporation').select('corporation_id, name, alliance_id').in('corporation_id', corpIds),
    supabase.from('corp_structure_share').select(SHARE_COLUMNS).in('corporation_id', corpIds).is('structure_id', null),
  ])
  const corpRows = (corps ?? []) as Array<{
    corporation_id: number | string
    name: string | null
    alliance_id: number | string | null
  }>
  const inAlliance = corpRows.filter((c) => c.alliance_id != null)
  const allianceIds = [...new Set(inAlliance.map((c) => Number(c.alliance_id)))]
  const { data: alliances } = allianceIds.length
    ? await supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds)
    : { data: [] }
  const allianceName = new Map(
    ((alliances ?? []) as Array<{ alliance_id: number | string; name: string | null }>).map((a) => [
      Number(a.alliance_id),
      a.name,
    ])
  )
  const wideRows = (rows ?? []) as StructureShareRow[]

  return inAlliance
    .map((c) => {
      const corporationId = Number(c.corporation_id)
      const allianceId = Number(c.alliance_id)
      const wide = wideRows.find((r) => Number(r.corporation_id) === corporationId)
      return {
        corporationId,
        corporationName: c.name ?? `Corporation #${corporationId}`,
        allianceId,
        allianceName: allianceName.get(allianceId) ?? `Alliance #${allianceId}`,
        enabled: wide != null && (wide.alliance_ids ?? []).map(Number).includes(allianceId),
      }
    })
    .sort((a, b) => a.corporationName.localeCompare(b.corporationName))
}
