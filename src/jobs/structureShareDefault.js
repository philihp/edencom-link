import { sudoSupabase } from '../supabase.js'

// The seeded alliance default of corp_structure_share
// (docs/sharing-layer/12-structure-share.md, "The alliance default"). Called
// by the corp-structures extract after each corporation's run, best-effort
// like the other bookkeeping in lib.js: a failure here never fails an extract
// that succeeded.
//
// Two rules, both keeping the cutover at parity with the hard-coded alliance
// policy the share rows replaced:
//
//   1. Seed ONCE. A corporation with no share row at all and no
//      corporation.structure_share_seeded_at stamp gets one null-subject row
//      naming its current alliance (or nobody, when it has none — the row is
//      then matched by no one, never read as public), and is stamped. A
//      director who deletes the row has opted out, and the stamp keeps it
//      deleted.
//   2. While seeded_default holds, alliance_ids tracks the corporation's
//      CURRENT alliance — joined, left, or changed — exactly as the dropped
//      policy did implicitly. The first director save clears seeded_default,
//      and from then on the arrays pin specific ids like every Revision 3 row.
//
// The alliance is read from `corporation`, which the character-directory job
// keeps current, so an alliance change reaches the grant within a day of it.

// What the seeded row's alliance_ids should be for a corporation. Pure.
export const seededAllianceIds = (allianceId) => (allianceId == null ? [] : [Number(allianceId)])

export const maintainStructureShareDefault = async (tag, corporation_id) => {
  try {
    const [{ data: corp, error: corpError }, { data: shares, error: shareError }] = await Promise.all([
      sudoSupabase
        .from('corporation')
        .select('alliance_id, structure_share_seeded_at')
        .eq('corporation_id', corporation_id)
        .maybeSingle(),
      sudoSupabase
        .from('corp_structure_share')
        .select('id, structure_id, alliance_ids, seeded_default')
        .eq('corporation_id', corporation_id),
    ])
    if (corpError) throw corpError
    if (shareError) throw shareError

    const allianceIds = seededAllianceIds(corp?.alliance_id)
    const seeded = (shares ?? []).find((s) => s.structure_id == null && s.seeded_default)

    if (seeded) {
      // Rule 2: keep the dynamic default dynamic.
      const current = (seeded.alliance_ids ?? []).map(Number)
      const same = current.length === allianceIds.length && current.every((id, i) => id === allianceIds[i])
      if (!same) {
        const { error } = await sudoSupabase
          .from('corp_structure_share')
          .update({ alliance_ids: allianceIds, updated_at: new Date().toISOString() })
          .eq('id', seeded.id)
        if (error) throw error
        console.log(`[${tag}] corp ${corporation_id}: seeded structure share now names alliance ${allianceIds}`)
      }
      return
    }

    // Rule 1: seed once, and only a corporation that has never been seeded and
    // holds no share of its own.
    if ((shares ?? []).length > 0 || corp?.structure_share_seeded_at != null) return

    const { error: insertError } = await sudoSupabase.from('corp_structure_share').insert({
      corporation_id,
      structure_id: null,
      alliance_ids: allianceIds,
      seeded_default: true,
    })
    if (insertError) throw insertError
    // The stamp lives on `corporation`, which may not have a row yet for a corp
    // the directory job has not named; upserting only these two columns leaves
    // a present row's name and alliance alone.
    const { error: stampError } = await sudoSupabase
      .from('corporation')
      .upsert({ corporation_id, structure_share_seeded_at: new Date().toISOString() }, { onConflict: 'corporation_id' })
    if (stampError) throw stampError
    console.log(`[${tag}] corp ${corporation_id}: seeded the default structure share (alliance ${allianceIds})`)
  } catch (e) {
    console.warn(`[${tag}] corp_structure_share default bookkeeping failed: ${e?.message ?? e}`)
  }
}
