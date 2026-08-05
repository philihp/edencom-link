# Phase 3: the Share dialog

**Status: ✅ done** — `shareDialog.tsx`/`shareData.ts`/`shareActions.ts` under
`src/app/asset/`, `resolveSignedShare`/`resolveShareParams` in
`src/app/asset/access.ts` (the old `src/app/ship/access.ts` and the ship
page's mint UI are gone; legacy `?token=` links still resolve, and saving
from the dialog retires the item's legacy row). Requires `TOKEN_SALT` on
Vercel for link shares — corp/alliance/public audiences work without it.

The user-facing surface: a **Share** button in the top right of an asset
view, opening an HTML `<dialog>` that creates and configures a share of the
currently displayed thing — an asset/container on `/asset/[locationId]` or a
ship on `/ship/[itemId]`.

## The dialog

`src/app/asset/shareDialog.tsx` (`'use client'`), rendered by both pages when
the viewer owns the displayed item (the same ownership check the ship page's
existing `shareControls.tsx` does). Native `<dialog>` element via
`showModal()` — no portal library; style with a CSS module on the global
theme vars (`::backdrop` included).

Contents, mapping 1:1 to the share row:

- **Corporations** — checkbox list of the owner's corporations (from their
  registrations, the way `shareAlliance.tsx` builds its alliance list) →
  `corporation_ids`.
- **Alliances** — same for alliances → `alliance_ids`.
- **Share link** — a toggle; when on, the row gets a `secret` and the dialog
  shows the copyable URL `${origin}/ship/${itemId}?share=<shareId>.<sig>`
  (or `/asset/…`), signed by `signShare()` from phase 1. "Reset link"
  rotates the secret (old URLs die); toggling off nulls it.
- **Public** — a toggle explained honestly ("anyone can see this"). On =
  clear both lists and the secret (the empty row _is_ the public share, per
  phase 1); the dialog greys the other controls while set.
- **Stop sharing** — deletes the row.

One share row per item (`unique (registration_id, item_id)`), so the dialog
is an editor over that single row: create on first save, update in place
after (the phase-1 UPDATE policy exists for exactly this).

## Server actions

`src/app/asset/shareActions.ts` (`'use server'`), on the **cookie-session
client** like every share writer (`fitting/actions.ts`,
`mercenary-dens/actions.ts`) — never the service role:

- `getAssetShare(itemId)` — the owner's existing row, if any.
- `saveAssetShare(itemId, { corporationIds, allianceIds, link, isPublic })` —
  proves ownership by reading the item through RLS on `character_asset`
  (which of the caller's registrations owns it fixes `registration_id`),
  filters the requested corp/alliance ids to ones the owner actually has (the
  `setSharedAlliances` defense), mints/rotates/nulls the secret
  (`randomBytes(32)`), upserts, and returns the signed link when one exists.
  Signing needs the secret + `TOKEN_SALT`, both server-side — the client only
  ever sees the finished URL.
- `revokeAssetShare(itemId)` — delete, RLS-scoped.

## The anonymous link path

For signed-in audiences, phase 2 already did the work — the pages render
shared content through plain RLS. The link token is the one audience RLS
can't see, so `?share=` is resolved at the app layer, replacing
`src/app/ship/access.ts`:

- `resolveSignedShare(param)` → split `<shareId>.<sig>`, service-role lookup
  of the share row by id, `verifyShareToken()`, then return the same
  `ShareScope` shape `resolveShareToken()` returns today — **plus** the
  subject `item_id`, and reject when the URL's item is not the share subject
  or inside its subtree (walk `asset_ancestors` from the requested id on the
  service client and require the subject among them; this is what makes the
  link recursive where the old token was exact-id-only).
- The pages' existing token branches swap `resolveShareToken` for this; the
  JS `.in('registration_id', …)` scoping on the service client stays as-is
  for the anon path.

## Legacy `shared_asset_token`

Old links must not break silently. Keep `resolveShareToken()` working as a
fallback during a deprecation window (try `?share=` first, then `?token=`);
stop **minting** old-style tokens (the ship page's share controls are
replaced by the dialog); list existing rows in the dialog's footer with a
"migrate" affordance that creates the new row and deletes the old. Drop the
table in a later cleanup once the window passes — its own tiny migration,
not part of this PR.

## Deliverables

- `shareDialog.tsx` + CSS module + `shareActions.ts` under `src/app/asset/`
  (shared by both pages; the ship page drops `shareControls.tsx` /
  `actions.ts` mint path).
- `resolveSignedShare` in `src/app/asset/access.ts` (move/rename of
  `src/app/ship/access.ts`), with the subtree containment check.
- Share button placement on both pages (top right, `pageHeader` flex slot).

## Verification

Owner: create each audience shape, see the row change; copy link opens the
ship/asset signed-out; reset link kills the old URL; revoke closes all
access. Grantee (second account): shared item appears at its `/asset/` and
`/ship/` URLs without any token. Legacy `?token=` links still resolve.
`pnpm run lint && pnpm test && pnpm run build`.
