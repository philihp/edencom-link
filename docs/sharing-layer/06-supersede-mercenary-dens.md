# Phase 6: fold mercenary dens into the unified model

**Status: ✅ done** — migration `20260806000000_den_share_unified.sql`
(one row per registration, alliances aggregated into `alliance_ids`, `id` uuid
primary key for future signed links; no empty-audience rows can be produced —
"shared with nobody" stays "no row", since an empty audience now means
public). `mercenary_den_shared_with_caller` rewrites onto
`share_audience_matches()` with the same signature, so the den and enemy-intel
widening policies are untouched. The `/mercenary-dens` alliance picker is kept
(better fit than the dialog for "usually one alliance") and its action becomes
a per-registration upsert — fixing the old non-transactional
delete-then-insert replace. Covered by `test/sql/den_share.sql`.

The den share was the pattern-setter and is the closest to the target
already; this phase is mostly a reshape. It carries one structural difference
worth keeping in mind: the den share is **whole-category, not per-item** —
one row means "share all my dens (and enemy intel) with this alliance", with
no den-level subject.

## Migration

`character_mercenary_den_share (registration_id, alliance_id)` rows collapse
to one row per registration in the Revision 3 shape:

- `registration_id uuid`, `alliance_ids bigint[]` (aggregate the existing
  rows), `corporation_ids bigint[] not null default '{}'` (new capability),
  `secret text` (new capability), `unique (registration_id)` — the subject
  stays "all my dens", so there is no `den_id` column; a per-den subject
  (design.md Stage B's open item) stays out of scope unless someone asks.
- `mercenary_den_shared_with_caller(reg_id)` rewrites onto the shared
  `share_audience_matches()` helper (extracted in phase 5). The two widening
  policies (`character_mercenary_den_over_time`,
  `mercenary_den_enemy_intel`) are untouched — they call the helper.
- Audience-read policy on the share table moves to the array/anon form.

Dens gain corp-scoped sharing and (if ever wanted) link/public audiences for
free, but `/mercenary-dens` renders nothing for anon today — the page itself
stays signed-in-only; a public den share simply means any signed-in user
sees the dens. Say so in the dialog copy.

## UI

`shareAlliance.tsx`'s checkbox list becomes the share dialog (subject kind
"my dens", no item id), or — since the alliance picker is genuinely a better
fit for "share with usually-just-one alliance" — keep the picker and simply
rewire `setSharedAlliances` to write the array column. **Decide when
building**; the data model doesn't care. Either way `actions.ts`'s wholesale
delete-then-insert becomes a single upsert of the array (fixing the existing
non-transactional replace, which can currently drop all shares when the
insert half fails).

## Deliverables

- Migration + `schema.sql` dual-write (reshape, helper rewrite, policies).
- `mercenary-dens/actions.ts` rewrite; picker or dialog per the decision
  above.

## Verification

Existing alliance shares survive the migration byte-for-byte in effect
(`test:sql` over a seeded copy: same rows visible before/after). The
`/mercenary-dens` topology shows a grantee the same dens as before. `pnpm
run lint && pnpm test && pnpm run build`.
