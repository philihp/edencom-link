# Front-page copy — the lore reading

## What this is

`src/app/page.tsx` is the only page on the site that has to explain what the
site _is_. Its copy went through one voice already (deadpan ERP-vendor parody:
"modules", "system of record", "go-live") and now sits on a second. This doc
records the second voice, so the next person to touch the page — or any page
that has to introduce the product — doesn't have to re-derive it.

## The premise

EDENCOM is not a generic sci-fi name to hang on a tracker. In EVE's fiction it
is a specific institution with a specific job: chartered by CONCORD in YC122
against the Triglavian invasion, its actual contribution was never the Vorton
projector. It was getting four empires that had spent a millennium shooting at
each other to read **one threat picture** — a standing datalink they all
trusted enough to act on.

That is the whole hook, because it is also literally what this site does. A
capsuleer with eleven alts has the same problem the empires had: many sources,
each partly right, none agreeing, no single record anyone trusts. The joke
writes itself and it is a true joke:

> EDENCOM was chartered to make four empires that had spent a millennium
> shooting at each other read the same threat picture. Edencom Link does the
> smaller, harder version of that job.

"Link" is therefore load-bearing — the datalink, the shared feed — not a
throwaway product suffix. (It is also the noun the Data Link feature
standardised on; see `sharing-layer/07-link.md`.)

## Voice rules

- **Anything that exists in the EVE client keeps its client name.** This is the
  rule the first draft got wrong, and it is the one that matters most. Cards are
  Wallet & Journal, Assets & Inventory, Manufacturing & Research, Market Orders,
  Structures & Fuel, Clones & Implants, Mercenary Den Operations, Analytics &
  Exports, Blueprint Calculator — not the flavour synonyms an earlier pass
  reached for (materiel registry, fortifications, personnel file, forward
  operations). We are fitting into the universe, not making players translate
  their own UI to find out whether we track wallets.
- **The lore frames; the features stay literal.** Flavour lives in the hero, the
  section intros, the doctrine headings and the closing. Card bodies stay
  concrete — ME and TE levels, fuel runway, `=IMPORTDATA()`.
- **Watch for collisions with our own nouns.** "Open the link" was cut as a CTA
  because Data Links (`/link`) are a real feature; a button by that name reads
  as navigation to them. Same class of error as renaming a game element.
- **One capsuleer's picture, not a war.** No invasion status, no
  Fortress/Advancing/Contested, no "defend New Eden". The institution is the
  borrowed frame; the subject is still someone's hangar.
- **The read-only claim carries the most weight.** "It is a receiver, not a
  transmitter" survives every rewrite because it is a structural fact rather
  than a promise. Keep the doctrine section's three claims structural — versioned
  rows, RLS, no write scope — and true.
- **Keep a corpse joke.** The pull quote's last clause is the one place the page
  is allowed to be funny at its own expense, and the site really does track
  frozen corpses.

## Structure (unchanged by the rewrite)

Hero → stats → nine sections → doctrine → standing up the link → pull quote →
closing. Both the `user` / signed-out branches are copy-swapped in the hero and
the closing; the CTA hrefs did not change. `home.module.css` was not touched —
the rewrite was strings only, so the class list in the page still matches the
stylesheet exactly.

## Numbers that need maintaining

The stats band asserts numbers that nothing in the codebase tests:

| Claim                                        | Source of truth                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23 scheduled extraction pipelines            | the `crons` array in `vercel.json`, less the two entries that extract nothing: `discord-notification-send` (an outbox sender) and `anon-sweep` (account cleanup) |
| 6h between sweeps on the per-character feeds | the `*/6` crons in `vercel.json`                                                                                                                                 |
| corporation-wide feeds sweep daily           | the daily crons — `corp-assets`, `corp-blueprints`, `corp-structures`, `universe-structures`, `structure-directory`, `character-directory`, `sde-mirror`         |
| 0 writes back to your account                | the ESI scopes requested at SSO — keep at zero                                                                                                                   |

Both of the first two were already wrong when this rewrite landed: the page
claimed 18 pipelines against 23, and "6h maximum sync latency" against a
schedule that has carried daily corp jobs for a long time. That is the failure
mode to watch — the numbers are asserted in prose, nothing checks them, and so
they rot silently every time a job is added or a schedule moves. Re-derive them
from the table above when touching `vercel.json`.

## Status

Shipped. The nine section names here are the front page's own vocabulary and
deliberately do **not** rename anything in the app — the nav, routes, and page
titles are unchanged. If that ever stops being true, that is a bigger project
than a copy pass and should get its own doc.
