// Delete Supabase preview branches the signup test left behind.
//
// test/signupBranch.test.ts deletes its own branch in `after`, but a cancelled
// job, a runner dying, or a crash between create and teardown leaks one — and a
// leaked branch is a running project that costs money for as long as it lives.
// This sweeps any branch whose name carries the test's prefix and which is
// older than an hour, so it can never delete a branch a concurrent run is
// still using.
//
// Usage: node .github/scripts/sweep-test-branches.mjs [name-prefix]
// Needs SUPABASE_ACCESS_TOKEN (Management API PAT) + SUPABASE_PROJECT_REF.
// Exits 0 even when it can't sweep: this runs as an always() cleanup step and
// must never turn a green test run red.
const MANAGEMENT_API = 'https://api.supabase.com'
const MAX_AGE_MS = 60 * 60 * 1000

const prefix = process.argv[2] ?? 'signup-test-'
const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = process.env.SUPABASE_PROJECT_REF

if (!token || !projectRef) {
  console.log('no Supabase credentials — nothing to sweep')
  process.exit(0)
}

const management = async (path, init = {}) => {
  const response = await fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

try {
  const branches = await management(`/v1/projects/${projectRef}/branches`)
  const stale = branches.filter(
    ({ name, is_default: isDefault, created_at: createdAt }) =>
      !isDefault && `${name}`.startsWith(prefix) && Date.now() - Date.parse(createdAt) > MAX_AGE_MS
  )

  if (stale.length === 0) {
    console.log(`no ${prefix}* branches older than an hour`)
    process.exit(0)
  }

  // Sequential rather than concurrent: this is cleanup, and a burst of deletes
  // against the Management API is the one thing that would rate-limit it.
  for (const branch of stale) {
    try {
      await management(`/v1/branches/${branch.id}`, { method: 'DELETE' })
      console.log(`deleted leaked branch ${branch.name} (${branch.id})`)
    } catch (error) {
      console.log(`could not delete ${branch.name}: ${error.message}`)
    }
  }
} catch (error) {
  console.log(`sweep skipped: ${error.message}`)
}
