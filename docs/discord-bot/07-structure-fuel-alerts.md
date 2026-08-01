# Stage 07 — Low structure fuel alerts

**PR size:** small · **Depends on:** 04 (outbox table), 05 (sender), 03
(linked channels)

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
