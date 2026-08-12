// Ephemeral Supabase preview branches (a Pro-plan feature) for tests that need
// a real Postgres + GoTrue rather than a stand-in. A branch is a full, isolated
// project cloned from the parent's migrations, so a test may sign users up,
// write rows, and never touch production data.
//
// Two ways in, both env-driven, both optional — with neither set the caller
// skips (see requireBranchEnv):
//
//   1. Ephemeral: SUPABASE_ACCESS_TOKEN (a Management API PAT) +
//      SUPABASE_PROJECT_REF. A branch is created for the run and deleted after.
//      Costs a few minutes of wall clock while it provisions.
//   2. Reuse:     SUPABASE_TEST_BRANCH_URL + _ANON_KEY + _SERVICE_KEY, pointing
//      at a branch someone already spun up (a persistent `develop` branch, or
//      one created by the CI workflow). Nothing is created or deleted.
//
// The Management API surface used here is documented at
// https://supabase.com/docs/reference/api/v1-create-a-branch.
const MANAGEMENT_API = 'https://api.supabase.com'

// Provisioning genuinely takes minutes: project create, then migrations.
const READY_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 5000

export type BranchTarget = {
  url: string
  anonKey: string
  serviceKey: string
  // null when the branch was handed to us rather than created by us — nothing
  // to tear down in that case.
  branchId: string | null
}

type Branch = {
  id: string
  name: string
  project_ref: string
  status: string
}

// Statuses the Management API reports while a branch comes up. Anything else
// (FUNCTIONS_FAILED, MIGRATIONS_FAILED, …) is terminal and fails the run.
const PENDING = ['CREATING_PROJECT', 'RUNNING_MIGRATIONS', 'MIGRATIONS_PASSED', 'FUNCTIONS_DEPLOYED']
const READY = 'ACTIVE_HEALTHY'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const management = async (path: string, init: RequestInit = {}) => {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const response = await fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

// Why the run is skipping, or null when it can proceed. Callers pass this
// straight to node:test's `skip` option so a developer running `pnpm test`
// without Supabase credentials sees the reason rather than a failure.
export const branchSkipReason = (): string | null => {
  const reused = process.env.SUPABASE_TEST_BRANCH_URL
  if (reused) {
    return process.env.SUPABASE_TEST_BRANCH_ANON_KEY && process.env.SUPABASE_TEST_BRANCH_SERVICE_KEY
      ? null
      : 'SUPABASE_TEST_BRANCH_URL is set without SUPABASE_TEST_BRANCH_ANON_KEY / _SERVICE_KEY'
  }
  if (!process.env.SUPABASE_ACCESS_TOKEN || !process.env.SUPABASE_PROJECT_REF) {
    return 'needs SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (or SUPABASE_TEST_BRANCH_* for a pre-made branch)'
  }
  return null
}

const readBranch = async (parentRef: string, branchId: string): Promise<Branch> => {
  const branches: Branch[] = await management(`/v1/projects/${parentRef}/branches`)
  const branch = branches.find(({ id }) => id === branchId)
  if (!branch) throw new Error(`branch ${branchId} vanished from project ${parentRef}`)
  return branch
}

// Poll until the branch reports ACTIVE_HEALTHY. Tail-recursive rather than a
// while loop, per the repo's iteration style; `deadline` is absolute so the
// bound covers the whole wait rather than each hop.
const awaitHealthy = async (parentRef: string, branchId: string, deadline: number): Promise<Branch> => {
  const branch = await readBranch(parentRef, branchId)
  if (branch.status === READY) return branch
  if (!PENDING.includes(branch.status)) {
    throw new Error(`branch ${branch.name} entered terminal status ${branch.status}`)
  }
  if (Date.now() > deadline) {
    throw new Error(`branch ${branch.name} still ${branch.status} after ${READY_TIMEOUT_MS}ms`)
  }
  await delay(POLL_INTERVAL_MS)
  return awaitHealthy(parentRef, branchId, deadline)
}

const fetchKeys = async (projectRef: string) => {
  const keys: { name: string; api_key: string }[] = await management(`/v1/projects/${projectRef}/api-keys?reveal=true`)
  const keyNamed = (name: string) => {
    const key = keys.find((candidate) => candidate.name === name)?.api_key
    if (!key) throw new Error(`project ${projectRef} exposes no ${name} key`)
    return key
  }
  return { anonKey: keyNamed('anon'), serviceKey: keyNamed('service_role') }
}

// GoTrue answers before the project is fully warm often enough to be flaky, so
// wait for /auth/v1/health to come back 200 before handing the branch over.
const awaitAuth = async (url: string, anonKey: string, deadline: number): Promise<void> => {
  const healthy = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } })
    .then((response) => response.ok)
    .catch(() => false)
  if (healthy) return
  if (Date.now() > deadline) throw new Error(`auth on ${url} never became healthy`)
  await delay(POLL_INTERVAL_MS)
  return awaitAuth(url, anonKey, deadline)
}

export const createTestBranch = async (namePrefix: string): Promise<BranchTarget> => {
  const reusedUrl = process.env.SUPABASE_TEST_BRANCH_URL
  if (reusedUrl) {
    return {
      url: reusedUrl,
      anonKey: `${process.env.SUPABASE_TEST_BRANCH_ANON_KEY}`,
      serviceKey: `${process.env.SUPABASE_TEST_BRANCH_SERVICE_KEY}`,
      branchId: null,
    }
  }

  const parentRef = `${process.env.SUPABASE_PROJECT_REF}`
  // Branch names are unique per project, and a crashed run can leave one
  // behind, so never reuse a fixed name.
  const branchName = `${namePrefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const created: Branch = await management(`/v1/projects/${parentRef}/branches`, {
    method: 'POST',
    body: JSON.stringify({ branch_name: branchName }),
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  const branch = await awaitHealthy(parentRef, created.id, deadline)
  const url = `https://${branch.project_ref}.supabase.co`
  const { anonKey, serviceKey } = await fetchKeys(branch.project_ref)
  await awaitAuth(url, anonKey, deadline)
  return { url, anonKey, serviceKey, branchId: created.id }
}

// Best-effort teardown: a leaked branch costs money, but a teardown failure
// must not mask the test result, so this reports rather than throws.
export const deleteTestBranch = async ({ branchId }: BranchTarget) => {
  if (!branchId) return
  try {
    await management(`/v1/branches/${branchId}`, { method: 'DELETE' })
  } catch (error) {
    console.error(`failed to delete branch ${branchId} — delete it by hand:`, error)
  }
}
