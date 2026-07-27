// STUB — the /jobs page design (docs/jobs-page.md), rendering against mock data
// so the layout can be argued about before the queries exist. Nothing here
// touches Supabase yet; every place a query belongs is marked TODO(jobs-page).
//
// What IS real: the registry, and the whole "Next run" column — those read
// vercel.json's actual cron entries through ./schedule.ts, so the times on
// screen are the times these jobs really fire.
//
// The implementing PR (blocked on cron-to-workflows phase 5 — see the plan)
// deletes ./stubData.ts, wires the four TODOs, moves Cell/RefreshButton/
// RefreshPoller over from src/app/character/refresh/, and retires that route.

import { Fragment } from 'react'

import { Freshness } from '../Freshness'
import { freshnessLevel, relativeTime } from '../freshness'
import { CharacterName, Name } from '../names'
import styles from './jobs.module.css'
import { NextRun } from './nextRun'
import { type JobEntry, isOverdue, jobsInSection, nextRunFor } from './registry'
import { STUB_ACTIVITY, STUB_CHARACTERS, STUB_CORPORATIONS, STUB_UNIVERSE, type StubEntityRun } from './stubData'

export const dynamic = 'force-dynamic'

const iso = (at: Date | null) => (at === null ? null : at.toISOString())

// The row's headline freshness is the OLDEST of the caller's entities, not the
// newest: the question is "is my data fresh", and one character that hasn't
// pulled since yesterday is the answer even when the other three ran minutes
// ago. A never-run entity is older than any timestamp.
const oldestRun = (entities: StubEntityRun[]): string | null => {
  if (entities.length === 0) return null
  // One entity that has never run makes the whole row "never" — nothing is
  // older than not having happened.
  if (entities.some((entity) => entity.lastRunAt === null)) return null
  return entities.reduce<string | null>(
    (oldest, entity) => (oldest === null || (entity.lastRunAt as string) < oldest ? entity.lastRunAt : oldest),
    null
  )
}

// The newest run across the caller's entities — the opposite end from
// oldestRun, and the right input to the overdue check: "did this job fire at
// all" is a different question from "is every one of my characters current".
// One lagging character must not make the *schedule* look broken.
const newestRun = (entities: StubEntityRun[]): string | null =>
  entities.reduce<string | null>(
    (newest, entity) =>
      entity.lastRunAt !== null && (newest === null || entity.lastRunAt > newest) ? entity.lastRunAt : newest,
    null
  )

const LEVEL_RANK: Record<string, number> = { fresh: 0, aging: 1, stale: 2, none: 3 }

// How many entities are behind the best-off one. "0 of 4 fresh" would be the
// normal state for a six-hourly job and teaches nothing; what's worth a note is
// one character lagging the others, which is a real symptom (dead token, missing
// scope) rather than the cadence doing its job.
const laggingCount = (entities: StubEntityRun[]): number => {
  const ranks = entities.map((entity) => LEVEL_RANK[freshnessLevel(entity.lastRunAt)])
  const best = Math.min(...ranks)
  return ranks.filter((rank) => rank > best).length
}

// First match wins, mirroring the status table in the plan. In the real page
// `queued`/`running`/`failed` come from the caller's refresh_task rows and from
// open heartbeats (started_at set, ended_at null); here they come from the stub.
const rowStatus = (entities: StubEntityRun[]): 'running' | 'queued' | 'failed' | 'idle' => {
  if (entities.some((e) => e.status === 'running')) return 'running'
  if (entities.some((e) => e.status === 'queued')) return 'queued'
  if (entities.some((e) => e.status === 'failed')) return 'failed'
  return 'idle'
}

const STATUS_LABEL: Record<string, string> = {
  running: '● running',
  queued: '· queued',
  failed: '✗ failed',
  idle: 'idle',
  pending: '· pending',
  done: '✓ done',
  error: '✗ error',
}

const Status = ({ status }: { status: string }) => (
  <span className={styles.status} data-status={status}>
    {STATUS_LABEL[status] ?? status}
  </span>
)

const JobLabel = ({ entry }: { entry: JobEntry }) => (
  <>
    {entry.label}
    <code className={styles.jobName}>{entry.job}</code>
  </>
)

// Placeholder for the real RefreshButton (src/app/character/refresh/refreshButton.tsx),
// which posts to the refreshCell server action. Disabled here — the stub kicks
// nothing.
const RefreshStub = ({ kickable }: { kickable: JobEntry['kickable'] }) =>
  kickable === 'never' ? null : (
    <button
      className={styles.refreshButton}
      disabled
      title={
        kickable === 'chancellor'
          ? 'Chancellor accounts only (gated server-side in refreshCell)'
          : 'Stub — the real button dispatches a refresh_task'
      }
    >
      refresh
    </button>
  )

// One section of job rows over a set of owned entities (characters or corps).
// The per-entity breakdown lives collapsed inside the count cell, so the page
// reads as one row per job by default and the old per-character matrix column
// is one click away.
const EntityJobTable = ({
  entries,
  entitiesByJob,
  entityNoun,
  showRunsAs = false,
  openFirst = false,
}: {
  entries: readonly JobEntry[]
  entitiesByJob: Record<string, StubEntityRun[]>
  // Plural noun for the owned entities — heads the count column and labels the
  // expander ("4 characters", "2 corporations").
  entityNoun: string
  showRunsAs?: boolean
  // Stub-only: start the first row expanded so the per-entity breakdown (and
  // the per-corp Runs as) is visible in a screenshot. The real page starts them
  // all collapsed.
  openFirst?: boolean
}) => (
  <table className={styles.table}>
    <thead>
      <tr>
        <th>Job</th>
        <th>{entityNoun.charAt(0).toUpperCase() + entityNoun.slice(1)}</th>
        {showRunsAs && <th>Runs as</th>}
        <th>Last run</th>
        <th>Status</th>
        <th>Next run</th>
      </tr>
    </thead>
    <tbody>
      {entries.map((entry) => {
        const entities = entitiesByJob[entry.job] ?? []
        const last = oldestRun(entities)
        const lagging = laggingCount(entities)
        return (
          <tr key={entry.job}>
            <td>
              <JobLabel entry={entry} />
            </td>
            <td>
              <details className={styles.breakdown} open={openFirst && entry.job === entries[0]?.job}>
                <summary>
                  {entities.length} {entityNoun}
                  {lagging > 0 && <span className={styles.lagging}> · {lagging} lagging</span>}
                </summary>
                <ul className={styles.breakdownList}>
                  {entities.map((entity) => (
                    <li key={entity.id}>
                      <span className={styles.breakdownName}>
                        {showRunsAs ? <Name name={entity.name} /> : <CharacterName name={entity.name} />}
                      </span>
                      {showRunsAs && (
                        <span className={styles.breakdownRunsAs}>
                          {entity.runsAsCorpmate ? (
                            <span className={styles.tokenNote}>a corpmate&apos;s token</span>
                          ) : (
                            <CharacterName name={entity.runsAs} />
                          )}
                        </span>
                      )}
                      <span className={styles.cell}>
                        {entity.status ? <Status status={entity.status} /> : <Freshness at={entity.lastRunAt} />}
                        <RefreshStub kickable={entry.kickable} />
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </td>
            {showRunsAs && (
              <td>
                {/* With one corporation the token has a name; with several it
                    differs per corp, so the collapsed row defers to the
                    expansion rather than picking one arbitrarily. */}
                {entities.length !== 1 ? (
                  <span className={styles.tokenNote}>per corp</span>
                ) : entities[0].runsAsCorpmate ? (
                  <span className={styles.tokenNote}>a corpmate&apos;s</span>
                ) : (
                  <CharacterName name={entities[0].runsAs} />
                )}
              </td>
            )}
            <td>
              <Freshness at={last} />
            </td>
            <td>
              <Status status={rowStatus(entities)} />
            </td>
            <td>
              {isOverdue(entry.job, newestRun(entities)) ? (
                <span className={styles.overdue} title="The previous scheduled fire didn't produce a run">
                  overdue
                </span>
              ) : (
                <NextRun at={iso(nextRunFor(entry.job))} />
              )}
            </td>
          </tr>
        )
      })}
    </tbody>
  </table>
)

const JobsPage = async () => {
  // TODO(jobs-page): redirect to /account/login when there's no session, and
  // read registrations + corporations the way src/app/character/refresh/page.tsx
  // does today (RLS scopes both to the caller).

  // TODO(jobs-page): replace the four STUB_* imports with
  //   1. latest_heartbeats() reduced to charBeats / corpBeats / accountBeats /
  //      corpRunsAs (lift the reduction out of the refresh page verbatim),
  //   2. a `heartbeat` select for OPEN rows (started_at set, ended_at null,
  //      ran_at within the hour) → the `running` status for scheduled runs,
  //   3. refresh_task rows from the last 24h → queued/running/failed overlay
  //      AND the activity section below,
  //   4. isChancellor(user.id) to decide whether industry-systems is kickable.
  const now = new Date()

  return (
    <>
      <h1>Extract jobs</h1>
      <p>
        Every job that feeds this site&apos;s data, when it last ran for you, and when it runs next. Schedules are UTC
        and come from the deployment&apos;s own cron configuration. Nothing starts just by opening this page — stale
        rows can be refreshed one at a time, and a refresh you kick shows up under Recent activity.
      </p>

      <p className={styles.stubBanner}>
        <strong>Design stub.</strong> Rows below are mock data — three invented characters and two invented corps. The{' '}
        <em>Next run</em> column is real: it&apos;s computed from <code>vercel.json</code>&apos;s cron entries. See{' '}
        <code>docs/jobs-page.md</code>; the page is blocked on <code>cron-to-workflows</code> phase 5.
      </p>

      <h2>Characters</h2>
      <p>
        Last run is <em>the oldest of your characters</em>&nbsp;— one character that hasn&apos;t pulled is what makes
        the data stale, even when the others just ran. Open a row for the per-character breakdown.
      </p>
      <EntityJobTable entries={jobsInSection('character')} entitiesByJob={STUB_CHARACTERS} entityNoun="characters" />

      <h2>Corporations</h2>
      <p>
        Corp extracts run once per corporation, under the token of a character holding the in-game role — director,
        accountant — that the endpoint requires. <em>Runs as</em> names whose token the last pull actually used, so a
        corp going stale because its only director token stopped working is visible as such.
      </p>
      <EntityJobTable
        entries={jobsInSection('corporation')}
        entitiesByJob={STUB_CORPORATIONS}
        entityNoun="corporations"
        showRunsAs
        openFirst
      />

      <h2>Shared universe</h2>
      <p>
        Game-wide data every account shares — the SDE mirror, structure and name resolution, industry cost indices.
        These run once for everyone, so a run someone else kicked shows here as running for you too. Relative times
        only: a nightly job would sit permanently red against the six-hourly freshness scale.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Job</th>
            <th>Last run</th>
            <th>Status</th>
            <th>Next run</th>
          </tr>
        </thead>
        <tbody>
          {jobsInSection('universe').map((entry) => {
            const last = STUB_UNIVERSE[entry.job] ?? null
            return (
              <tr key={entry.job}>
                <td>
                  <JobLabel entry={entry} />
                </td>
                <td>
                  <span className={styles.cell}>
                    {/* No freshness dot here on purpose — see the plan. The real
                        page should take a `plain` prop on <Freshness> so this
                        text keeps ticking; the stub renders it server-side. */}
                    {last === null ? '—' : relativeTime(last, now.getTime())}
                    <RefreshStub kickable={entry.kickable} />
                  </span>
                </td>
                <td>
                  <Status status="idle" />
                </td>
                <td>
                  {isOverdue(entry.job, last, now) ? (
                    <span className={styles.overdue} title="The previous scheduled fire didn't produce a run">
                      overdue
                    </span>
                  ) : (
                    <NextRun at={iso(nextRunFor(entry.job, now))} />
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <h2>Recent activity</h2>
      <p>
        Refreshes you kicked in the last 24 hours, newest first, grouped by the batch that dispatched them. This is the
        only place an on-demand run that failed while you were away is visible.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Enqueued</th>
            <th>Job</th>
            <th>For</th>
            <th>Status</th>
            <th>Took</th>
          </tr>
        </thead>
        <tbody>
          {STUB_ACTIVITY.map((task, index) => (
            <Fragment key={task.id}>
              <tr>
                <td>
                  {STUB_ACTIVITY[index - 1]?.batchId === task.batchId
                    ? ''
                    : relativeTime(task.enqueuedAt, now.getTime())}
                </td>
                <td>
                  <code className={styles.jobName}>{task.job}</code>
                </td>
                <td>{task.forWhom === null ? '—' : <Name name={task.forWhom} />}</td>
                <td>
                  <Status status={task.status} />
                  {task.error !== null && <div className={styles.errorText}>{task.error}</div>}
                </td>
                <td>{task.durationSeconds === null ? '—' : `${task.durationSeconds}s`}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* TODO(jobs-page): <RefreshPoller done={!anyActive} /> — moved from
          src/app/character/refresh/poller.tsx. Polls every 2s only while a task
          is pending/running; the Next run countdowns tick client-side and need
          no server round trip. */}
    </>
  )
}

export default JobsPage
