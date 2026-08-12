// Ephemeral Supabase preview branches (a Pro-plan feature) for tests that need
// a real Postgres + GoTrue rather than a stand-in. A branch is a full, isolated
// project, so a test may sign users up, write rows, and never touch production
// data. Its schema comes from schema.sql, applied here — see applySchema for
// why the branch's own migration run can't provide it.
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
import { readFile } from 'node:fs/promises'

const MANAGEMENT_API = 'https://api.supabase.com'
// Resolved from this file, not the cwd, so it works wherever node is invoked
// from.
const SCHEMA_SQL = new URL('../../schema.sql', import.meta.url)

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

// GET /v1/projects/{ref}/branches. Its `status` tracks the branch's SETUP
// (migrations, functions) and never reports the project's health — those are
// two different enums on two different endpoints, which is the trap here.
type Branch = {
  id: string
  name: string
  project_ref: string
  status?: string
}

// GET /v1/branches/{id}. Its `status` is the project-health enum, the one that
// actually reaches ACTIVE_HEALTHY.
type BranchDetail = {
  ref: string
  status: string
}

// Setup statuses that mean "still working". Everything else — passed, failed,
// deployed — means setup has stopped moving. The field is deprecated upstream,
// so treat it as advisory: absent means "nothing to wait for".
const SETUP_RUNNING = ['CREATING_PROJECT', 'RUNNING_MIGRATIONS']
// Project-health statuses. Anything outside these two is terminal.
const HEALTH_READY = 'ACTIVE_HEALTHY'
const HEALTH_PENDING = ['COMING_UP', 'UNKNOWN', 'RESTORING', 'RESTARTING', 'RESIZING', 'UPGRADING']

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
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${body}`)
  }
  // Some endpoints (the SQL runner among them) answer with an empty body.
  return body ? JSON.parse(body) : null
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

const shrug = (error: unknown) => (error instanceof Error ? error.message : `${error}`)

// Build the branch's schema from schema.sql — the repo's single source of
// truth — rather than from supabase/migrations.
//
// Supabase's own branch setup runs the migrations, and here that ALWAYS fails
// at the first file: `20260602000000_add_asset_name.sql` alters
// `asset_over_time`, a table only schema.sql creates (and which later
// migrations renamed). That is by design in this repo — production was built
// from schema.sql and the migrations are incremental patches on top of it, so
// the migration set has never been able to build a database from nothing. A
// branch therefore comes up ACTIVE_HEALTHY with an empty public schema, and
// MIGRATIONS_FAILED on a fresh branch says nothing about this PR.
//
// Applying schema.sql ourselves gives the tests the schema the app actually
// runs on, and incidentally proves schema.sql still applies cleanly to an
// empty database.
const applySchema = async (childRef: string) => {
  const sql = await readFile(SCHEMA_SQL, 'utf8')
  await management(`/v1/projects/${childRef}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  })
}

// Supabase records branch setup (clone → migrate → seed → deploy) as an
// "action run" whose log carries the Postgres error itself. The run is filed
// under one of the two projects depending on how the branch was created, so
// try both. Best-effort throughout: failing to read a log must never replace
// the failure being reported.
const setupLog = async (parentRef: string, childRef: string, branchId: string) => {
  const runFor = async (ref: string) => {
    const runs: { id: string; branch_id: string }[] = await management(`/v1/projects/${ref}/actions?limit=20`)
    const run = runs.find((candidate) => candidate.branch_id === branchId) ?? runs[0]
    return run ? { ref, id: run.id } : null
  }

  try {
    const found = (await runFor(childRef).catch(() => null)) ?? (await runFor(parentRef).catch(() => null))
    if (!found) return '(no setup run found for this branch)'
    const response = await fetch(`${MANAGEMENT_API}/v1/projects/${found.ref}/actions/${found.id}/logs`, {
      headers: { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` },
    })
    if (!response.ok) return `(setup log unavailable: ${response.status})`
    // Only the tail matters — the failing statement is at the end.
    return `─ setup log (tail) ─\n${(await response.text()).split('\n').slice(-40).join('\n')}`
  } catch (error) {
    return `(setup log unavailable: ${shrug(error)})`
  }
}

// Wait until the project answers (ACTIVE_HEALTHY) AND its setup has stopped
// moving. Two different enums on two different endpoints, which is the trap
// here: the listing's `status` tracks setup (migrations, functions) and never
// reports health, while branch detail's reports health and never setup.
//
// Setup ending in MIGRATIONS_FAILED is the norm for this repo, not a failure
// to report — see applySchema. What matters is that it has finished, so the
// schema we then apply isn't racing a migrate step.
//
// Tail-recursive rather than a while loop, per the repo's iteration style;
// `deadline` is absolute so the bound covers the whole wait, not each hop.
const awaitHealthy = async (parentRef: string, branchId: string, deadline: number): Promise<BranchDetail> => {
  const [detail, branch]: [BranchDetail, Branch] = await Promise.all([
    management(`/v1/branches/${branchId}`),
    readBranch(parentRef, branchId),
  ])
  const setup = branch.status
  const where = `branch ${branch.name} (health ${detail.status}, setup ${setup ?? 'n/a'})`

  if (detail.status !== HEALTH_READY && !HEALTH_PENDING.includes(detail.status)) {
    throw new Error(`${where} entered a terminal state\n${await setupLog(parentRef, detail.ref, branchId)}`)
  }
  const settled = !setup || !SETUP_RUNNING.includes(setup)
  if (detail.status === HEALTH_READY && settled) return detail

  if (Date.now() > deadline) throw new Error(`${where} was not ready after ${READY_TIMEOUT_MS}ms`)
  await delay(POLL_INTERVAL_MS)
  return awaitHealthy(parentRef, branchId, deadline)
}

type ApiKey = { name: string; api_key: string | null; type?: string | null }

// Projects on legacy keys name them 'anon' and 'service_role'; projects on the
// newer key system name them freely and distinguish by `type`
// (publishable ≈ anon, secret ≈ service_role). Match on name first, fall back
// to type, so the helper works on either vintage of project.
const fetchKeys = async (projectRef: string) => {
  const keys: ApiKey[] = await management(`/v1/projects/${projectRef}/api-keys?reveal=true`)
  const pick = (name: string, type: string) => {
    const key = (keys.find((candidate) => candidate.name === name) ?? keys.find((candidate) => candidate.type === type))
      ?.api_key
    if (!key) throw new Error(`project ${projectRef} exposes no ${name} (or ${type}) key`)
    return key
  }
  return { anonKey: pick('anon', 'publishable'), serviceKey: pick('service_role', 'secret') }
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
    // with_data explicitly false: the branch gets the migrations, never a copy
    // of production's rows.
    body: JSON.stringify({ branch_name: branchName, with_data: false }),
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  try {
    // The branch's own project ref — `created.project_ref` is populated too,
    // but the detail response is the authoritative one once it is healthy.
    const { ref } = await awaitHealthy(parentRef, created.id, deadline)
    await applySchema(ref)
    const url = `https://${ref}.supabase.co`
    const { anonKey, serviceKey } = await fetchKeys(ref)
    await awaitAuth(url, anonKey, deadline)
    return { url, anonKey, serviceKey, branchId: created.id }
  } catch (error) {
    // A branch that never came up is still a running, billable project, and
    // the caller has no handle to tear it down — nothing was returned. Delete
    // it here, then rethrow the original failure.
    await deleteTestBranch({ url: '', anonKey: '', serviceKey: '', branchId: created.id })
    throw error
  }
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
