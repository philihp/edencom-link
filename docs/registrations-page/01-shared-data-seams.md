# Phase 1 — extract the data seams (pure refactor, zero behavior change)

Both old pages assemble their data inline in their `page.tsx`. The new page
needs the same data; copying the assembly would let the three pages drift.
This phase moves the assembly into shared server modules, leaving each old
page a thin render over the same objects `/registration` will later consume.

**This phase changes no rendered byte.** Review it as a pure refactor; the
old pages' HTML output before and after must be identical.

## 1a. `src/app/character/characterData.ts`

Extract from `src/app/character/page.tsx` (currently ~180 lines of fetching
and folding) a single entry point:

```ts
export type CharacterOverview = {
  id: string                 // registration uuid
  characterId: number | null // EVE bigint id (may be null pre-callback)
  name: string
  balance: string | null            // raw; formatBisk at render
  locationSystem: string | null
  ship: { itemId: string; label: string } | null
  cloneSystems: string[]            // sorted, uniq, fetchSystemPaths shapes
  implants: string[]                // resolved type names
  slots: { counts: SlotCounts; max: SlotMax } | null // null = skills not shared
}

export const fetchCharacterOverviews = async (
  supabase: SupabaseClient
): Promise<{ characters: CharacterOverview[]; error: PostgrestError | null; status: number; statusText: string }>
```

Everything the current page computes moves in: the wallet latest-balance fold,
location→system-name map, clone system paths (uniq + sorted), implant type
names, current ship label (`"<name> (<type>)"` collapse rule), and the
job-slot fold — including the corp-jobs contribution via
`countJobSlots` and the `slotMax` skill fold. Keep the existing comments;
they carry load (e.g. why corp jobs count against the installer's slots, why
`slotMax.has()` gates the bubbles).

`page.tsx` keeps: the auth gate (`establishedUser` → `redirect('/')`), the
`getEnabledScopes`/`hasNoOptionalScopes` warning computation (or move it too —
implementer's call, the new page needs it as well), and all JSX including
`JobSlots`. **Move `JobSlots` into its own file**
(`src/app/character/jobSlotBubbles.tsx` — name it to not collide with
`src/app/industry/jobSlots.ts`) so `/registration` can render the identical
bubbles; it keeps using `character.module.css` classes for now (phase 2 may
restyle on the new page only).

## 1b. `src/app/jobs/jobsData.ts`

Extract from `src/app/jobs/page.tsx` everything between the four parallel
queries and the JSX:

```ts
export type JobsOverview = {
  registrations: { id: string; name: string; corporation_id: number | null }[]
  characterEntities: Record<string, EntityRun[]>    // job → per-registration rows
  corporationEntities: Record<string, EntityRun[]>  // job → per-corp rows (runsAs et al.)
  accountBeats: Map<string, Beat>                   // shared-universe section
  runFor: (job: string, key: string, beat: Beat | undefined) => Omit<EntityRun, 'id' | 'name'>
  activity: ReturnType<typeof activityRows>
  anyActive: boolean                                // drives RefreshPoller
  chancellor: boolean
  now: number
}

export const fetchJobsOverview = async (supabase: SupabaseClient, userId: string): Promise<JobsOverview>
```

Moves in verbatim: the `Beat`/`OpenBeat`/`Task` types, the three time floors,
the four-way `Promise.all`, the `charBeats`/`corpBeats`/`accountBeats`/
`corpRunsAs` fold (with its corp-newest-wins and skipped-never-claims-Runs-as
rules), `openCells`, `taskByCell` (with the corp-job re-keying through
`corporationOf`), the `corporations` grouping, the `universe_name` corp-name
lookup, and the `characterEntities`/`corporationEntities` construction with
its representative-picking comments. `isChancellor` moves in too (the new
page needs it for the shared-universe kick gating).

`page.tsx` keeps: auth gate, all JSX (`Cell`, `Status`, `JobLabel`,
`EntityJobTable`, `PlainAge`, the four sections, `RefreshPoller`), and
`export const dynamic = 'force-dynamic'`.

Note `rows.ts`, `registry.ts`, `schedule.ts` are already pure and tested —
untouched. The presentational components (`Cell`, `EntityJobTable`, `Status`,
`nextRun.tsx`, `refreshButton.tsx`, `poller.tsx`) stay where they are in this
phase; phase 3 decides which are shared vs. re-styled.

## Verification

- `pnpm run lint`, `pnpm test`, `pnpm run build` — all green.
- Manual: `/character` and `/jobs` render identically (the refactor moves
  code, not behavior; diff the built HTML if in doubt).
- The extracted modules take `supabase` as a parameter (the codebase's
  existing pattern for MCP-shareable helpers — see `owners.ts` et al.) rather
  than creating their own client; both callers pass the cookie client.

One PR, titled as a refactor. Commit onto `claude/jobs-registrations-merge-ue96so`.
