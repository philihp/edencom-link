// Loaded into every test process by the `test` script (`node --test --import`),
// including the child process node:test spawns per file.
//
// The gate in branchSkipReason() keeps the one network-aware suite from
// running uninvited — but that is protection by audit: it covers the network
// path we know about. This is protection by mechanism: under plain `pnpm test`,
// fetch itself refuses, so a future test (or anything it transitively imports)
// that tries to leave the machine fails loudly instead of quietly succeeding.
// fetch is the single chokepoint on purpose — every network client this
// codebase's tests can reach (supabase-js, the Management API helper in
// supabaseBranch.ts) goes through it.
//
// `pnpm run test:branch` sets RUN_BRANCH_TESTS=1, which leaves fetch alone —
// that suite's whole job is the network. Decided once at process start: a test
// flipping the env var mid-run (branchEmail.test.ts does, to exercise the
// skip gate) neither arms nor disarms it.
if (process.env.RUN_BRANCH_TESTS !== '1') {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    throw new Error(
      `pnpm test is offline: refused fetch(${input instanceof Request ? input.url : input}). ` +
        'Network-backed tests run only via pnpm run test:branch (RUN_BRANCH_TESTS=1).'
    )
  }) as typeof fetch
}
