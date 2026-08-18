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

- **The lore frames; the features stay literal.** Every card still says what
  the page actually does — ME/TE research state, fuel runway, `=IMPORTDATA()`.
  The flavour is in the section names and the closing clause of each body, not
  in place of the substance. Nobody should have to decode a metaphor to learn
  whether we track wallets.
- **Nouns come from the institution, not the enterprise.** record (not system
  of record), feed / section (not module), doctrine (not pillars/governance),
  accreditation (not onboarding), sweep (not sync run), standing watch (not
  go-live). The ERP words are the previous voice; don't mix the two.
- **One capsuleer's picture, not a war.** Resist escalating into Triglavian
  cosplay — no invasion status, no Fortress/Advancing/Contested, no
  "defend New Eden". The institution is the borrowed frame; the subject is
  still someone's hangar.
- **The read-only claim carries the most weight.** "It is a receiver, not a
  transmitter" is the best line on the page precisely because it is a
  structural fact, not a promise. Keep the doctrine section's claims
  structural — versioned rows, RLS, no write scope — and true.
- **Keep the corpses.** The pull quote's last clause is the one place the page
  is allowed to be funny at its own expense.

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
