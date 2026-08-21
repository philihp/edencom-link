# Stage 07 — Low structure fuel alerts

**PR size:** small · **Depends on:** 04 (outbox table), 05 (sender), 03
(linked channels) · **Status: shipped**

## Implementation notes (what the code does differently)

The scoping below is accurate except on three points the code had to settle:

- **`fuel_expires` moved.** It now lives in `corp_structure_status`
  (own-corp-only, while `corp_structure` opened up to alliance-mates), not
  on `corp_structure`. Detection reads that table's previous row — before
  the extract's upsert overwrites it — and enqueues after the write lands,
  so a failed upsert can't leave an alert whose dedupe state was never
  stored.
- **The dedup rule needed a second clock.** "Compare against the previous
  observation" is not enough on its own: while nobody refuels, the stored
  `fuel_expires` and the fresh one are the _same instant_, so both sides of
  a naive comparison read the same remaining time and the alert never
  fires. The previous reading has to be judged against
  `corp_structure_status.updated_at` — the time it was taken. Yesterday's
  "7.5 days left" over today's "6.5 days left" is the crossing. The
  `structure-fuel:<structure_id>:<expiry unix>` source key is a backstop
  under that, not a substitute: the outbox's unique index only guards rows
  that haven't been sent yet.
- **Formatting lives with detection**, not with the sender as suggested
  below. Stage 04 set that precedent and the outbox stores a fully composed
  `body`, so the sender stays source-agnostic — it posts rows, it doesn't
  know what a mercenary den or a fuel bay is.

Silent by design: a structure with no fuel timer at all, and one already
dry. A daily extract against a 7-day threshold always warns a live
structure first, so reaching "expired" unannounced means nobody was
listening yet — and back-dated obituaries for long-dead structures are
noise on the first run after a channel is linked.

## Goal

When a structure a user monitors is running low on fuel, post an alert to
their linked Discord channel(s). First alert source beyond den
reinforcement, and the proof that the outbox generalizes.

## Detection

`corp_structure.fuel_expires` is already extracted daily by the
`corp-structures` job (`src/jobs/corpStructures.js`). At the end of each
run, for each structure whose `fuel_expires` has crossed under a threshold
(start with 7 days; per-user configurability is a follow-up), enqueue one
outbox row — mirroring how stage 04 hooks `character-mercenary-dens`.

Dedup: the crossing must fire once, not on every daily run while low. Use
the same mechanism stage 04 picks (compare against the previous
observation, or an outbox uniqueness key like
`(source, structure_id, fuel_expires)` — refueling pushes `fuel_expires`
forward, naturally re-arming the alert).

Audience: structures are corp-scoped; alert every user with a linked
channel whose registration is in that corp (same resolution the
`/structure` page's RLS implies), not just the character whose token pulled
the extract.

## Message

Structure name, system, and "fuel expires <relative time>" — reusing the
name resolution the `/structure` page already does. Formatting lives with
the stage-05 sender's per-source message builders.

## Milestone / acceptance

- A structure with `fuel_expires` inside the threshold produces exactly one
  outbox row per crossing, and the message arrives in the linked channel.
- A refuel then a re-drain below threshold re-alerts.
- `pnpm run lint` + `pnpm run build` pass.

## Out of scope

- Per-user thresholds / muting individual structures.
- Escalation tiers ("7 days" then "48 hours").
- In-site notification surface (the website alerts UI is its own future
  project; this stage is Discord delivery only).
