import { fileURLToPath } from 'node:url'

import { pullIndustryIndexes } from '../industryIndexes.js'

// Snapshot the public industry cost indices for every system we hold a structure
// in, building a history of how those indices drift over time. The ESI endpoint is
// public (no token) and the work is account-wide — it reads corp_structure and the
// global /industry/systems/ feed — so this job takes no character/user scope and
// runs for everyone at once on its own hourly cron (industry_index.yml). It was
// pulled out of the structures job, where running it per-character fanout blew past
// the 60s queue limit.
export const runIndustryIndex = async () => {
  await pullIndustryIndexes()
}

const execute = async () => {
  try {
    await runIndustryIndex()
  } catch (e) {
    console.error('[industry_index] FAILED', e)
    process.exit(1)
  }
}

// Only run as a CLI (npm run industry-index / the scheduled workflow) when invoked
// directly. When imported elsewhere, the top-level run must not fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  execute()
}
