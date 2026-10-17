# Sharing the corpse collection

`/corpses/[characterID]` is one account's frozen-corpse collection: every
corpse across every character on the account, each tile named for the pilot it
came from, under a title naming the account's main. It is a vanity page, and
the whole point of it is that the collection shows up pooled.

## The hole it closes

The page shipped public, with no share row and no gate of any kind. Its own
comment said otherwise — "Owners opt in by enabling the 'corpses' flag; a page
for an account that hasn't is a 404" — but that mechanism was retired when
`graphql` and `link` launched and took `src/flags.ts` with them, and nothing
replaced it. `/privacy` likewise promised the page "stays off unless you enable
it".

So, for an anonymous visitor:

- `/corpses/<any registered character id>` resolved that character to its
  account, listed **every** character's corpses, and titled the page **"The
  Many Corpses of `<the account's main>`"**. Hand it an alt's id, read back the
  main's name.
- Two character ids rendering the same page — same title, same corpse list —
  proved the two characters share an owner.
- A 404 meant only "not registered here", so the route enumerated who uses the
  deployment.

That is exactly the correlation the sharing layer is built to prevent: it is
why the world-readable `character_directory` carries no `user_id` at all
(`schema.sql`, "This is the 'character' table in docs/sharing-layer/design.md"),
and why `show_as_main` on an asset share scrubs everything leading back to the
holder (`src/app/ship/[itemId]/presentedOwner.ts`). The data layer held; one
page walked around it with the service role.

## The shape

`corpse_share` is the standard Revision 3 audience row — `corporation_ids`,
`alliance_ids`, a nullable `secret`, fully public being the row that names no
one — keyed on `user_id`, exactly like [`bpo_share`](../schema.sql). The
subject is an account's whole collection, pooled across its characters, which
is the same deliberate exception to the per-character grantor rule that the BPO
showcase makes, and safe for the same reason: owner-initiated, opt-in, and no
row means not shared.

Two rules do the work:

1. **No row is a 404.** Nothing is correlated until the owner asks for it, and
   a guessed character id confirms nothing — not even that the account exists.
2. **The URL names the account's MAIN and only its main.** An alt's id resolves
   to nothing even where the account does share, so the alt → main hop is
   closed whatever the audience is. `resolveCorpseSubject` recomputes the
   account's main (`pickMain`, the `is_main` flag else the oldest character —
   the same rule `/asset` uses to build the link) and refuses a URL that names
   anyone else.

Authorization is `src/app/corpses/access.ts`, not RLS, because the page reads
through the service role like `/bpos` and `/corpses` always have. The ladder
itself — public, signed link, audience — is shared with `/bpos` in
`src/app/shareLadder.ts`; the audience leg re-asks `corpse_share` as the viewer
so membership is Postgres's `share_audience_matches` rather than a second
implementation. `test/sql/corpse_share.sql` covers the policies.

The link-preview card (`/corpses/[characterID]/card`) answers only what a
signed-out visitor could open — fully public, or a signed `?share=` link —
because a chat client fetching a preview carries no session. The page's
`generateMetadata` does the same, so an unshared collection's `<title>` says
nothing but "Frozen corpses".

## What the owner sees

The owner always sees their own page; that is where the `ShareDialog` lives,
reached from the "View frozen corpses" link on `/asset` (which already uses the
main's character id). Sharing, aiming at a corporation or alliance, minting a
signed link and revoking all behave as they do on every other share subject.
