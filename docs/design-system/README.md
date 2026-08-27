# Edencom Link Design System

Edencom Link is a dark-themed EVE Online companion tool for tracking characters, ISK, clones, industry, and market activity across a player's alt roster — a terminal-flavored utility for spreadsheet-brained pilots, not a marketing product.

## Sources
- Reference implementation: `Characters.dc.html` from a companion Claude project (`https://claude.ai/design/p/7a1d9ae7-feec-425d-aa2a-4a03beacc53a`), a Characters list/detail screen showing the nav, character cards, and ESI sync status table.
- Reference screenshots: Indexes page (sparkline table + range picker) and Structures page (structure cards with icon, fields, service/rig tags, and per-index sparklines) — uploaded directly, not a live codebase/Figma.
- Brand typeface: uploaded Eve Sans Neue OTF files (regular/condensed/expanded, each with bold + italic).
- No logo was provided — a small snowflake glyph (❄, unicode) stands in as a placeholder mark next to the wordmark; do not treat it as the brand's logo.

## Content fundamentals
Terse, lowercase, technical — reads like a self-hosted ops dashboard, not a consumer app. Nav items are lowercase (`characters`, `assets`, `market`). Numbers carry EVE's own units verbatim (`bISK`, ticker codes in brackets like `[DSWB]`). Footer signs off casually, first-person: "Made with love by {character} — {date}". No emoji.

## Visual foundations
- **Dark by default.** Canvas near-black (`--bg-canvas #17181a`), surfaces step up slightly (`--bg-surface`, `--bg-elevated`, `--bg-overlay`) — no pure black, no big color blocks.
- **One accent, used sparingly:** lavender-purple (`--accent-primary #8f8ff5`) for primary actions and links; everything else is grayscale until a status color is needed.
- **Status colors** (good/warn/bad/info — green/amber/red/blue) mark freshness and sync state, never decorative.
- **Sharp-ish corners:** 4–8px radius, small and consistent — not pill-shaped, not boxy-sharp.
- **Borders over shadows:** 1px hairline borders (`--border-subtle`) delineate cards and table rows; the one shadow token (`--shadow-overlay`) is reserved for popover/dropdown menus.
- **Type:** Eve Sans Neue for body/UI, Eve Sans Neue Expanded for headings. No serif, no display flourish.
- **No imagery, no illustration, no gradients.** This is a data-utility surface — avatars are hashed-color initial circles, not photography.
- **Bracket-delimited nav** (`[ characters | assets | market ]`) is a signature motif — literal `[`/`]` glyphs, pipe-less links separated by gaps, lowercase.
- **Sparklines everywhere:** every metric (industry indexes, structure revenue) gets a thin-line sparkline with a faint semi-transparent midpoint reference line and a minimum 1% visual range so flat series still read as a line; high/low labels sit to its left, the bold current value to its right.
- **One global range control:** a top-right dropdown ("1 day" / "3 days" / "7 days" / "14 days" / "28 days") drives every sparkline on the page at once — there's no per-chart range control.
- **Keyboard focus:** a 2px blue (`--status-info`) outline box, offset slightly from the element — visible on nav links, buttons, and selects.

## Components
- `components/core/` — `Avatar`, `StatusDot`, `Badge`, `Button`
- `components/navigation/` — `BracketNav`
- `components/cards/` — `EntityCard`
- `components/data/` — `StatusTable`, `Sparkline`, `SparklineStat`
- `components/forms/` — `RangePicker`

### Intentional additions
This system currently has no attached codebase/Figma component library — the inventory above was extracted directly from the one reference screen provided (Characters list + detail). It's deliberately small; expand it as more reference screens are provided rather than inventing standard components ahead of need.

## Tokens
`tokens/colors.css` — dark surface scale, accent, status colors, radius/shadow. `tokens/interactions.css` — focus-visible outline. Both imported via `styles.css`.

## Fonts
`fonts/fonts.css` — Eve Sans Neue, Eve Sans Neue Condensed, Eve Sans Neue Expanded (each regular/bold/italic/bold-italic), self-hosted from uploaded OTFs.

## Index
- `styles.css` — root stylesheet, `@import`s only
- `tokens/colors.css` — color/radius/shadow tokens
- `fonts/fonts.css` — `@font-face` rules
- `guidelines/type-eve-sans-neue.card.html` — type specimen
- `components/*/*.jsx` + `.d.ts` + `.prompt.md` — component source + contract + usage
- `explorations/Direction Options.html` — early palette/type explorations (superseded by the tokens above, which follow the real reference screen)

---

## In this repo

Imported from the Claude Design handoff bundle (`Account Settings.dc.html` is
the settings control panel + button/link vocabulary; `Site Shell.dc.html` is a
further-out shell exploration, not implemented). The tokens map onto
`src/app/globals.css`'s existing custom-property names — see the comment at
the top of that file. Fonts are self-hosted at `public/fonts/`. The full
bundle (all artboards, component JSX, `_ds_bundle.js`) is not committed; ask
the design project for it.
