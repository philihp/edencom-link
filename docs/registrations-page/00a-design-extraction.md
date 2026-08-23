# 00a — Design extraction: `Registrations v2.dc.html`

> Written from the design source itself (turn 10 of the artboard), plus the
> current `src/app/character/page.tsx` and `src/app/jobs/page.tsx` for the
> parity comparison. Phases 2–4 build from this document; they should not need
> to re-open the HTML. The verbatim design files sit in `design/` beside this
> doc (the `_ds/<hash>/` directory is flattened to `design/_ds/`, so the
> HTML's relative links won't resolve — they're reference material, not a
> runnable page).

The artboard contains four options, all of the same design (each rendered
dark and light):

- **10a** — desktop, populated matrix (the primary layout to implement)
- **10b** — mobile, per-character cards (the responsive intent)
- **10c** — desktop, first-run empty state
- **10d** — mobile, first-run empty state

## 1. Page structure (10a, desktop)

Top to bottom:

1. **App header** — brand mark ❄ + "edencom link" wordmark, bracket nav
   `[ characters | registrations | links | assets ]` with the active item in
   primary text color, user avatar right-aligned. (This is the mockup's own
   chrome; the real app keeps its existing `header`.)
2. **Page header row** (flex, baseline-aligned):
   - `<h1>` copy: **"registrations & refresh"** (lowercase, expanded face in
     the mockup; see §4 for the house-typography translation).
   - Status line under it: `4 characters · 1 needs re-auth · next scheduled
     sweep in 14m` — warn-colored fragment for the re-auth count, mono for
     the countdown.
   - Right-aligned actions: ghost button **"↻ refresh all"**, primary button
     **"+ register a character"**.
3. **The matrix** — one bordered, rounded container (`border-subtle`,
   radius 6, `overflow:hidden`), rows as CSS grid
   `230px repeat(5, 1fr) 130px`:
   - **Header row**: `CHARACTER` (uppercase, letterspaced, tertiary) · five
     scope columns (`assets wallet location industry market`), each column
     header stacking the scope name over a small bordered **↻ sweep button**
     ("refresh this scope for every character that has it") · right column
     `ALL JOBS`.
   - **Template row** (row zero, elevated background, strong bottom border):
     label "**next request asks for**" (accent, bold) + subtext "what you
     grant when you register"; one checkbox per scope (filled accent ✓ = will
     be requested, hollow = not); right cell shows the count "4 of 5". This
     is editable state — it drives the scope set of the next SSO request.
   - **One row per character**: avatar + name + mono subline
     (`[DSWB] · main`); five cells; row tail = **↻** ("refresh all jobs for
     this character") + a quiet **remove** text action.
   - A character needing re-auth (Kel Torin) replaces the mono subline with a
     warn-colored "grants trail the template · **re-auth**" (re-auth is a
     link).
4. **Legend row** below the matrix (small, tertiary): the four cell states
   spelled out, and right-aligned a warn StatusDot summary
   "3 jobs blocked by missing grants".

### Cell anatomy & states

Each cell stacks a **grant icon** over a **last-run timestamp** (mono, 9.5px,
tertiary). The four grant states — this is the page's core idea, grant and
job in one cell:

| icon | meaning | timestamp |
| --- | --- | --- |
| green circled ✓ | requested + granted | relative time ("12m ago") |
| red circled ✕ | requested, missing | **"never — no grant"** in `status-bad` — the ✕ explains why the job never runs |
| blue circled ✓ | granted but not in the template | still refreshes; normal timestamp |
| amber dot | neither requested nor granted | "—" |

Overlays on the base state:
- **running**: cell gains an accent-bordered ↻ button beside the icon and the
  timestamp reads "running…" in accent.
- **failed**: timestamp reads "failed 2h ago · **retry**" (warn color, retry
  is a link) — shown on a blue-✓ cell in the mockup, so failure is orthogonal
  to grant state.

Cells without a grant have **no** refresh trigger — nothing to run.

### Bulk-trigger placement (the axes rule)

- column header ↻ → that scope, every character that has it
- row tail ↻ → every job for that character
- in-cell ↻ → that one cell (shown on the active/running cell)
- header "↻ refresh all" → everything

## 2. Per-character contents vs. today's `/character` tile

What the mockup **shows** per character: avatar, name, corp ticker + role
note (mono), per-scope grant + freshness cells, re-auth warning state,
per-character refresh, remove.

What it **adds** over `/character`: per-scope freshness (the whole point),
per-character and per-scope refresh triggers, the template row (today the
scope set lives on `/settings/grants` — the "Limited access selected"
warning links there), the remove action, the re-auth state.

### Parity gaps — every `/character` field the mockup omits

Constraint: parity wins by default; the user rules on each.

1. **ISK balance** (`formatBisk` of latest `character_wallet` row)
2. **Location** (solar system from `character_location`)
3. **Current ship** — linked to `/ship/{itemId}`
4. **Clone systems** list (sorted, deduped, full system paths)
5. **Implants** list (type names)
6. **Job-slot bubbles** (`JobSlots`: manufacturing/research/reaction rows,
   filled/ready/empty per slot, ceilings from skills; rendered only when
   skill data exists)
7. **"Limited access selected" warning** when every optional scope is off —
   arguably subsumed by the template row showing 0 checked, but the link to
   `/settings/grants` must survive somewhere
8. Raw Supabase **error dump** on query failure (dev affordance)

Likely resolution (user to confirm): the matrix row is the *registration*
view; fields 1–6 are *character-state* and belong to phase 4's integration
(e.g. an expandable row or a details column), not dropped.

## 3. Jobs presentation vs. today's `/jobs`

The mockup renders **only the per-character scope jobs**, fused into the
grant matrix — one cell = one (character, scope) job, last run + status
inline. Today's `/jobs` "Characters" section (one row per job, collapsible
per-character breakdown, refresh-all per job) maps onto the matrix directly:
the collapsed breakdown becomes the always-visible column, refresh-all
becomes the column-header ↻.

The mockup's five columns (`assets wallet location industry market`) are a
*presentation* of the character-section job registry — the implementation
derives columns from `jobsInSection('character')`, not from a hardcoded five.

### Parity gaps — `/jobs` capabilities with no home in the mockup

1. **Corporations section** — runs-as token attribution, "not a director"
   skip state, per-corp refresh
2. **Shared universe section** — account-wide jobs, plain relative times,
   Chancellor-only kick
3. **Recent activity** — 24h task log, batch grouping, durations, error text,
   abandoned detection
4. **Next run / overdue** — cron-derived next fire per job (the mockup's
   header shows only one global "next scheduled sweep in 14m")
5. **Status vocabulary** — mockup shows running/failed/never; `/jobs` also
   has queued, pending, skipped, abandoned, done, error
6. **RefreshPoller** — the re-request loop while kicks are in flight (pure
   behavior; carries over invisibly)
7. Freshness dots (`<Freshness>`) — the mockup uses relative text + state
   icons instead; decide whether the dot scale survives

Suggested resolution (user to rule): corp jobs could be a second matrix
(rows = corporations, same pattern, runs-as in the row subline); shared
universe and recent activity remain tables below the matrix. None of these
may be dropped.

## 4. Token mapping — design bundle → `src/app/globals.css`

The implementation uses the **app's** tokens. Mapping from
`design/_ds/tokens/colors.css`:

| design token | value | app token |
| --- | --- | --- |
| `--bg-canvas` | #17181a | `--paper` |
| `--bg-surface` | #1c1d20 | `--paper` (page bg; the mockup's surface/canvas split is one step — do not invent a third paper) |
| `--bg-elevated` | #1f2024 | `--paper-raised` (template row, cards) |
| `--bg-overlay` | #26272c | `--paper-raised` (menus) |
| `--border-subtle` | #2b2c31 | `--line-soft` |
| `--border-strong` | #34353b | `--line` |
| `--text-primary` | #f4f4f5 | `--ink` |
| `--text-secondary` | #9a9da5 | `--ink-soft` |
| `--text-tertiary` | #6c6f76 | `--ink-faint` |
| `--accent-primary` | #8f8ff5 | `--accent` |
| `--accent-primary-hover` | #a3a3f7 | `--accent-strong` |
| `--link` / `--link-hover` | #a996f0 | `--link` (keep browser blue/purple convention) |
| `--status-good` | #3ecf7e | `--ok` |
| `--status-warn` | #e3b341 | `--warn` |
| `--status-bad` | #f0555c | `--danger` |
| `--status-info` | #4f7cff | **net-new** — no info token exists; add `--info` to `globals.css` with a comment naming this design as origin (used for the blue "granted, not requested" ring) |
| `--radius-sm/md/lg` | 4/6/8px | `--radius-sm` (7px) / `--radius` (10px) — use the app's two |
| `--shadow-overlay` | — | unused on this page |

The app is light-by-default with a dark `prefers-color-scheme` block; the
mockup's `.lt` light variant confirms the design survives inversion — no new
theme machinery needed.

### Typography

The design bundle's Eve Sans Neue faces are **not imported**. Roles translate:

- Body/UI (Eve Sans Neue) → `--sans` (the page default)
- Headings (Eve Sans Neue Expanded, lowercase) → house rule applies: **one
  face per heading, whole heading**. "registrations & refresh" is a sentence,
  not a thing's name → page-default sans. Character names in row cells may
  use the `Name`/`CharacterName` serif components per existing convention.
- Mono (`ui-monospace` in the mockup: timestamps, `[DSWB]`, `14m`, counts) →
  `--mono`, consistent with the `.num`/`code` convention.
- The mockup's lowercase-heading and uppercase-letterspaced-column-header
  styling is Edencom Link voice; adopt the *structure*, keep the app's case
  conventions unless the user opts into the lowercase voice.

## 5. Interactions

From `design/_ds/tokens/interactions.css`: keyboard focus = 2px info-blue
outline, offset 2px — the app's existing `:focus` treatment
(accent border + tint shadow) is the equivalent; keep the app's.

Implied by the mockup (all to implement with the existing
`dispatchRefresh` / `refresh_task` machinery, reused as-is):

- ↻ buttons at all four granularities (§1); running state swaps the cell into
  accent ↻ + "running…" — the existing `RefreshPoller` keeps it live.
- **retry** link on a failed cell (re-kick that one job).
- **re-auth** link on a trailing character (SSO round-trip via existing
  `register` action).
- Template-row checkboxes toggle the next-request scope set (today's
  `/settings/grants` state).
- **remove** per row — today's registration removal, surfaced inline.
- No collapsibles on desktop; the matrix is fully expanded by design.

`design/support.js` is the Claude Design runtime and `design/ios-frame.jsx`
is the mockup's device frame — presentation chrome only, never implemented.

## 6. Responsive intent (from 10b/10d)

The artboard's mobile options are explicit about narrow widths:

- The matrix **becomes per-character cards**: card header = avatar, name,
  mono subline, one 44px ↻ (whole character); body = one line per scope
  (state icon · scope name · mono time) — same four states and same
  "never — no grant" / "running…" strings.
- The **template row becomes a chip card** at the top ("next request asks
  for", pill chips with the ✓/hollow checkbox per scope).
- **Column sweeps move into a bottom sheet** ("[ refresh a scope
  everywhere ]", pill per scope with a mono ×N count of eligible
  characters), opened from a ⋯ button in the page header.
- A blocked character's card gets a warn border and a full-width primary
  **"re-auth to unblock N jobs"** button.
- Page title shortens to "registrations"; status line compresses
  (`4 characters · 3 jobs blocked · sweep in 14m`).
- Touch targets ≥44px throughout.
- The legend compresses to one sentence explaining ✕ and blue ✓ only.

## First-run empty state (10c/10d)

- The empty state **is the matrix, ghosted**: header row with all five
  columns labeled (no ↻ sweeps — nothing to sweep), the template row **live
  and editable** (copy: "**your first request will ask for**" / "adjust
  before you register — you grant only what's checked"), then one dashed
  ghost row (dashed avatar circle + dashed name bar + five dashed cell
  circles, ~45% opacity) where the first character will appear.
- Centered under the ghost row: "no characters registered yet", one line of
  explanation ("register one through EVE's SSO and this row fills in —
  refresh jobs start within a minute of the grant"), one primary CTA
  **"register your first character"**, and the reassurance line "uses CCP's
  official login — we never see your password" with a "what each scope
  unlocks" link.
- Page subtitle in this state: "every number in this app starts here — a
  character, and what they let us read."
- Mobile (10d): same pieces stacked — template chip card, then a dashed
  empty-state card with a full-width CTA above the fold.
