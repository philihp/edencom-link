# PR 3 (optional, needs a design decision): move `esf:build` off the build

**Status: deferred.** Do not start this without the repo owner confirming the
storage approach — it introduces new infrastructure (Vercel Blob) that the
SDE mirror deliberately avoided.

## Context

After doc 01 merges, the only remaining build-time SDE download is
`esf:build` (`src/buildEsfData.js`): it builds the six protobuf files
(`public/esf-data/*.pb2`, per `src/esf.proto`) that the vendored
`@eveshipfit/react` `EveDataProvider` fetches client-side from
`dataUrl="/esf-data/"` for the ship-fitting wheel on `/ship/[itemId]`.
It downloads CCP's SDE zip once per build (skips when the files already
exist, but Vercel build containers start clean).

## Sketch (to be validated)

- Add a step to the nightly `sde-mirror` workflow (or a sibling workflow on
  the same cron) that, when a new SDE build lands, rebuilds the six `.pb2`
  files and uploads them to **Vercel Blob** (`@vercel/blob`, new dependency,
  needs a Blob store + `BLOB_READ_WRITE_TOKEN` in the project). Reuse
  `src/buildEsfData.js`'s encode logic — refactor it so download and encode
  are separable, and reuse the Range-read zip helpers from
  `src/jobs/sdeMirror.js` (`listEntries` / `fetchEntryBuffer`) instead of its
  current `unzip` binary spawn, which doesn't exist at runtime.
- Point the fitting UI at the Blob: `EveDataProvider`'s `dataUrl` prop (set
  where the component is rendered — grep for `dataUrl="/esf-data/"`) becomes
  the Blob base URL (env var), or keep `/esf-data/` as a same-origin path via
  a small route/redirect so the client bundle needs no env plumbing.
- Then `esf:build` leaves `prebuild`, and builds download nothing from CCP.

## Open questions for the repo owner

1. Vercel Blob vs. committing the `.pb2` files to the repo (they're a few MB
   and change once per patch — a weekly bot PR like `bump-eveshipfit.yml`
   could refresh them) vs. leaving `esf:build` at build time permanently.
2. Memory budget: `typeDogma.jsonl` inflated is the largest input; the encode
   step must fit a workflow function invocation.
3. Cache headers/versioning on the Blob objects so a patched SDE doesn't
   fight browser caches (the current same-origin files get Vercel's static
   asset caching).
