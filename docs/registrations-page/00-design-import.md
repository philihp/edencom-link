# Phase 0 — import the design mockup

## Status: blocked on a user action

The source of truth for the page's layout is the Claude Design project

    https://claude.ai/design/p/de18d8e9-89f2-4cbd-bf90-48d4454a18d1?file=Registrations+v2.dc.html

The remote session that wrote this plan could not read it: the claude_design
MCP authenticates via `/design-login`, which needs an interactive terminal,
and the URL itself 403s unauthenticated. **The user needs to get the files
into reach** — either Claude Design's *"Send to Claude Code Web"* (seeds the
project into the workspace), or exporting/pasting the files, or running the
import from an interactive session that can `/design-login`.

## Files to import

From the design project (the whole project is readable; these are the ones
that matter):

- `Registrations v2.dc.html` — the artboard being implemented
- `_ds/edencom-link-design-80a92c6f-29aa-4e04-8f29-c0c9bc110814/_ds_bundle.js`
- `_ds/edencom-link-design-80a92c6f-29aa-4e04-8f29-c0c9bc110814/fonts/fonts.css`
- `_ds/edencom-link-design-80a92c6f-29aa-4e04-8f29-c0c9bc110814/styles.css`
- `_ds/edencom-link-design-80a92c6f-29aa-4e04-8f29-c0c9bc110814/tokens/colors.css`
- `_ds/edencom-link-design-80a92c6f-29aa-4e04-8f29-c0c9bc110814/tokens/interactions.css`
- `ios-frame.jsx`
- `support.js`

Commit them verbatim under `docs/registrations-page/design/` (flatten the
`_ds/...` hash directory to `design/_ds/`). They are reference material, not
shipped code — nothing imports them at runtime.

## Deliverable: the extraction

With the files in hand, write `docs/registrations-page/00a-design-extraction.md`
recording, so later phases never need to re-open the HTML:

1. **Page structure** — the section order and hierarchy of the artboard
   (where the character cards sit relative to the job tables; what is a card,
   a table, a collapsible; what the `<h1>`/section headings say).
2. **Per-character card contents** — which of the `/character` tile fields the
   mockup shows, where, and what it *adds* (freshness? per-character refresh?).
   Any old-page field the mockup omits goes in a "parity gaps" list for the
   user to rule on (constraint: parity wins by default).
3. **Jobs presentation** — how the mockup renders the three job sections and
   recent activity, vs. today's tables.
4. **Token mapping** — each `tokens/colors.css` / `styles.css` value mapped to
   the existing custom properties in `src/app/globals.css` (`--serif`,
   `--sans`, `--mono`, and the color tokens). The implementation uses the
   app's tokens, not the design bundle's; net-new tokens are added to
   `globals.css` with a comment naming this design as their origin.
   Remember the house typography rule: one face per heading, whole heading.
5. **Interactions** — anything `interactions.css` / `support.js` imply
   (hover, expand/collapse, transitions) worth carrying over. `ios-frame.jsx`
   is the mockup's device frame — presentation chrome only, never implemented.
6. **Responsive intent** — the artboard is one viewport; note what should
   stack/collapse at narrow widths, since the real page must work on mobile.

The extraction doc is what phases 2–4 build from. If the design cannot be
obtained, phases 2–4 fall back to composing the existing `/character` and
`/jobs` markup under the new route with only layout-level changes — parity is
already guaranteed either way; only the visual ambition changes.
