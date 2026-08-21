# Stage 04 — Reinforcement detection + notification outbox

**PR size:** medium (the interesting one) · **Depends on:** 03 only for
end-to-end usefulness — technically independent and testable on its own ·
**Blocks:** 05

## Goal

When an extract run observes a den entering reinforcement, exactly one
pending notification row appears in an outbox table. No Discord traffic in
this stage; the milestone is verified in the database.

## Where detection lives

`src/jobs/characterMercenaryDens.js` already appends one
`character_mercenary_den_status` observation per den per run, carrying
`reinforcement_end` (null when not reinforced). The transition is therefore
visible at extract time by comparing the fresh observation against the den's
**previous latest** observation:

- previous `reinforcement_end` null (or in the past) **and** new
  `reinforcement_end` non-null and in the future ⇒ **newly reinforced** —
  enqueue.
- both non-null but the timestamp moved ⇒ a new/changed timer — treat as
  newly reinforced too (dedupe key below makes this safe).
- anything else ⇒ no event.

Do the comparison inside `syncCharacterMercenaryDens` (it already has the
detail payload in hand; one extra select of the previous observation per den
— dens per character are single digits, so this is cheap). Detection at
extract time — not a separate scanner job — means the on-demand "Refresh
ESI" queue path and the CLI get detection for free, since they run the same
sync function.

**First-observation rule:** a den whose _first ever_ observation is already
reinforced should still enqueue (user links mid-reinforcement and wants the
ping). A den that vanishes from the listing with a pending outbox row: leave
the row — the den being transferred/unanchored mid-timer is itself worth a
ping (the message just states the facts as observed).

## The outbox table — decision

The ntfy plan (`docs/ntfy-notifications.md`, unimplemented) designed a
generic `notification` table keyed by `source`, delivering via the user's
ntfy topic. This project needs a different delivery target (a
`discord_channel` row). **Decision: mint the generic `notification` table
now, ntfy-plan shape plus two columns:**

- `transport text not null` — `'discord'` now; `'ntfy'` when that project
  lands (its sweep then filters on its own transport).
- `discord_channel_id` — nullable FK to `discord_channel`, set when
  `transport = 'discord'`. (If a user has N linked channels, detection
  fans out N rows, one per channel — delivery state is per-message.)

Everything else follows the ntfy doc's design verbatim: `user_id`,
`source`, `subject`, `body`, `scheduled_at`, `sent_at`, `attempts`,
`created_at`, the partial unique index on pending `(user_id, source)`
(extended with `discord_channel_id`), the due-rows partial index, RLS
owner-scoped with service-role writes. Dual-write `schema.sql` + migration
as always.

**Dedupe key:** `source = 'mercenary-den:<den_id>:<reinforcement_end unix>'`
— one ping per den per distinct timer. Re-observing the same reinforcement
on the next 6-hourly run hits the partial unique index (and, once sent, the
sent row simply exists); a _changed_ timer mints a new source and pings
again, which is the desired behavior. Treat the `23505` duplicate error as
success, as the ntfy doc prescribes.

`scheduled_at = now()` — reinforcement pings are immediate, the column
exists for transports/sources that schedule ahead (ntfy industry jobs,
future pre-timer reminders).

## Message content (composed at detection time, stored in the row)

Reuse the exact format users already paste by hand
(`src/app/mercenary-dens/copyDiscordPing.tsx`):

```
Mercenary Den Reinforced - `JVA-FE` planet `II` at <t:1784057275:s> @ <t:1784057275:R>
```

`<t:…:s>`/`<t:…:R>` are Discord timestamp markups (viewer-local wall clock +
live countdown) — they belong in the body string as-is. System + roman
resolve via `getSdePlanet` (`src/sdePlanets.ts`) from the den's `planet_id`;
subject: `Mercenary Den Reinforced`. Composing at detection keeps the sender
dumb (stage 05 just posts `body`).

## Detection latency — cadence decision

`character-mercenary-dens` runs every 6h (`:30`). A den reinforced just
after a run pings up to ~6h late; EVE reinforcement timers run ~1–1.5 days,
so a 6h-late ping still leaves most of the timer, but it's a real chunk.
The pull is cheap (one listing + one detail request per den, single-digit
dens per character). **Recommendation: bump the cron to hourly in this PR**
(`vercel.json` schedule change only; the fan-out shape already scales) and
note ESI's own cache time on these endpoints as the effective floor. If
hourly feels too chatty for ESI etiquette, every 2–3h is still a big
improvement. Decide in the PR, but decide deliberately — this bounds the
product's usefulness.

## Milestone / acceptance

- `pnpm run lint` + `pnpm run build` pass; migration applies.
- Simulation (no real reinforced den needed — ESI has to report an actual
  timer for the live path, which can't be arranged on demand): factor the
  compare-and-enqueue step into a small exported function taking (previous
  observation, new observation, linked channels) so it can be exercised
  directly from a throwaway harness script against a dev database.
  Acceptance is: **given** prev-null/new-future observations, **exactly
  one** pending outbox row per linked channel exists, and re-running the
  detection produces no duplicates.
- A character with no linked channels produces no rows (detection consults
  `discord_channel` before writing).

## Out of scope

- Sending anything (stage 05).
- Repair/anarchy/state-change events other than reinforcement.
- Shared-den (corp) notifications, corkboard-intel notifications.
