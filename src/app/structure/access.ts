// Resolves a structure share link, or a fully public structure share, into
// the one structure a signed-out (or otherwise unentitled) visitor may read
// (docs/sharing-layer/12-structure-share.md, "The signed link and the public
// case"). Runs on the service-role client — which bypasses RLS — so every
// caller MUST scope its reads to the returned structure and corporation, and
// to the two tables a share opens: corp_structure and corp_structure_rig.
// Never corp_structure_status, the journal or the jobs.
import { parseShareParam, tokenSalt, verifyShareToken } from '@/shareToken'
import { createServiceClient } from '@/utils/supabase/service'

import { coveringStructureShares, isPublicStructureShare, type StructureShareRow } from './shareRows'

export type StructureShareScope = {
  structureId: string
  corporationId: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The share rows that could cover this structure: the owning corporation's
// row for it, and the corporation-wide one. Read with the service role, since
// the caller sees nothing yet — that is the point.
const coveringShares = async (
  supabase: ReturnType<typeof createServiceClient>,
  structureId: string
): Promise<{ corporationId: number; rows: StructureShareRow[] } | null> => {
  const { data: structure } = await supabase
    .from('corp_structure')
    .select('corporation_id')
    .eq('structure_id', structureId)
    .maybeSingle<{ corporation_id: number | string }>()
  if (!structure) return null
  const corporationId = Number(structure.corporation_id)
  const { data } = await supabase
    .from('corp_structure_share')
    .select('id, corporation_id, structure_id, corporation_ids, alliance_ids, secret, tenants, seeded_default')
    .eq('corporation_id', corporationId)
  return { corporationId, rows: coveringStructureShares((data ?? []) as StructureShareRow[], structureId) }
}

// `?share=<signature>`: the signature is an HMAC over the share id keyed by the
// row's secret + TOKEN_SALT (src/shareToken.ts); a legacy `<id>.<signature>`
// link narrows the candidates to the named row.
export const resolveStructureShare = async (
  param: string,
  structureId: string
): Promise<StructureShareScope | null> => {
  const { shareId, signature } = parseShareParam(param)
  if (signature === '') return null
  if (shareId !== null && !UUID_RE.test(shareId)) return null

  let salt: string
  try {
    salt = tokenSalt()
  } catch {
    return null
  }

  const covering = await coveringShares(createServiceClient(), structureId)
  if (!covering) return null
  const share = covering.rows
    .filter((row) => shareId === null || row.id === shareId)
    .find((row) => row.secret != null && verifyShareToken(row.id, row.secret, salt, signature))
  return share ? { structureId, corporationId: covering.corporationId } : null
}

// A structure whose owner shares it with everyone: readable signed-out, with no
// link, through the same scoped path.
export const resolvePublicStructure = async (structureId: string): Promise<StructureShareScope | null> => {
  const covering = await coveringShares(createServiceClient(), structureId)
  if (!covering) return null
  return covering.rows.some(isPublicStructureShare) ? { structureId, corporationId: covering.corporationId } : null
}

// The one entry point the page uses: a link first, then the public case.
export const resolveStructureAccess = async (
  share: string | undefined,
  structureId: string
): Promise<StructureShareScope | null> =>
  (share ? await resolveStructureShare(share, structureId) : null) ?? resolvePublicStructure(structureId)
