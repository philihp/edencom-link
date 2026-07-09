/** @type {import('next').NextConfig} */
const nextConfig = {
  // @eveshipfit/dogma-engine ships a Rust-compiled WASM module (a bundler-style
  // `import * as wasm from "*.wasm"`) for fit statistics. Turbopack (default
  // since Next 16) handles this natively; an explicit empty config just opts
  // in without changing any behavior, per Next's own guidance for this case.
  turbopack: {},
  env: {
    // Captured at build time (i.e. when the deployment is built).
    BUILD_TIME: new Date().toISOString(),
    // Vercel exposes the deployed commit sha at build time.
    COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
  },
  // The IMPORTDATA CSV endpoints moved under /api/character/ when the data model
  // was renamed by ESI endpoint. Users' Google Sheets still carry the old URLs
  // (with ?token=...), so keep them working; Sheets follows redirects and Next
  // preserves the query string.
  redirects: async () => [
    { source: '/api/assets', destination: '/api/character/assets', permanent: true },
    { source: '/api/orders', destination: '/api/character/orders', permanent: true },
    { source: '/api/industry', destination: '/api/character/jobs', permanent: true },
    { source: '/characters/refresh', destination: '/character/refresh', permanent: true },
  ],
}

export default nextConfig
