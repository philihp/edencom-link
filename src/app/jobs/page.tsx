// /jobs — every extract job that feeds this site's data: when it last ran for
// the caller, what it's doing right now, and when it runs next (docs/jobs-page.md).
// Replaces the /character/refresh matrix, which could only answer the first of
// those three and only for on-demand runs.
//
// Everything here is read from our own tables — heartbeats (completed and open),
// the caller's refresh_task rows — plus vercel.json's cron entries for the
// schedule. RLS scopes all of it: own registrations, own characters' and corps'
// heartbeats, the shared user_id-null rows every signed-in account sees.

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

import { Freshness } from '../Freshness'
import { freshnessLevel, relativeTime } from '../freshness'
import { CharacterName, Name } from '../names'
import { fetchJobsOverview } from './jobsData'
import styles from './jobs.module.css'
import { NextRun } from './nextRun'
import { RefreshPoller } from './poller'
import { RefreshAllButton, RefreshButton } from './refreshButton'
import { type JobEntry, type Kickable, isOverdue, jobsInSection, nextRunFor } from './registry'
import { type EntityRun, isAbandoned, laggingCount, newestRun, oldestRun, rowStatus } from './rows'

// Always read fresh — the poller re-requests this server component every couple
// of seconds while any kicked-off job is still in flight.
export const dynamic = 'force-dynamic'

const iso = (at: Date | null) => (at === null ? null : at.toISOString())

const STATUS_LABEL: Record<string, string> = {
  running: '● running',
  queued: '· queued',
  failed: '✗ failed',
  // Not a failure: nothing was pulled because nothing was permitted to be. The
  // reason (which character, which role) rides along as the title.
  skipped: '— not a director',
  idle: 'idle',
  pending: '· pending',
  done: '✓ done',
  error: '✗ error',
  abandoned: '✗ abandoned',
}

const Status = ({ status, error }: { status: string; error?: string | null }) => (
  <span className={styles.status} data-status={status} title={error ?? undefined}>
    {STATUS_LABEL[status] ?? status}
  </span>
)

const JobLabel = ({ entry }: { entry: JobEntry }) => (
  <>
    {entry.label}
    <code className={styles.jobName}>{entry.job}</code>
  </>
)

// One entity's state for one job: whatever it's doing now if that's anything,
// otherwise its freshness dot — with a refresh button once the dot is off green
// (or the last run failed), for the jobs this account may kick.
const Cell = ({
  job,
  entity,
  kickable,
  showFreshness = true,
}: {
  job: string
  entity: EntityRun
  kickable: Kickable
  // The shared jobs deliberately render plain relative text instead: the
  // freshness scale is tuned to the six-hourly per-character cadence, and a
  // nightly job would sit red ~23 hours a day (docs/jobs-page.md).
  showFreshness?: boolean
}) => {
  const inFlight = entity.status === 'running' || entity.status === 'queued'
  const offerRefresh =
    kickable !== 'never' &&
    !inFlight &&
    // Re-kicking a run we're not permitted to make just re-earns the same 403.
    entity.status !== 'skipped' &&
    (!showFreshness || entity.status === 'failed' || freshnessLevel(entity.lastRunAt) !== 'fresh')
  return (
    <span className={styles.cell}>
      {inFlight || entity.status === 'failed' || entity.status === 'skipped' ? (
        <Status status={entity.status} error={entity.error} />
      ) : showFreshness ? (
        <Freshness at={entity.lastRunAt} />
      ) : (
        <PlainAge at={entity.lastRunAt} />
      )}
      {offerRefresh && <RefreshButton job={job} characterId={entity.id === '' ? null : entity.id} />}
    </span>
  )
}

// Relative time without the freshness dot, for the shared-universe rows.
const PlainAge = ({ at }: { at: string | null }) => <>{at === null ? '—' : relativeTime(at, Date.now())}</>

// One section of job rows over a set of owned entities (characters or corps).
// The per-entity breakdown lives collapsed inside the count cell, so the page
// reads as one row per job by default and the old per-character matrix column
// is one click away.
const EntityJobTable = ({
  entries,
  entitiesByJob,
  entityNoun,
  kickableOf,
  showRunsAs = false,
  offerRefreshAll = false,
}: {
  entries: readonly JobEntry[]
  entitiesByJob: Record<string, EntityRun[]>
  // Plural noun for the owned entities — heads the count column and labels the
  // expander ("4 characters", "2 corporations").
  entityNoun: string
  kickableOf: (entry: JobEntry) => Kickable
  showRunsAs?: boolean
  // Characters only: offer one button that kicks the job for every character,
  // so the answer to "they're all stale" isn't four clicks. Corp jobs dispatch
  // per corporation, which the per-corp cells already do one at a time.
  offerRefreshAll?: boolean
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
        const lagging = laggingCount(entities)
        const kickable = kickableOf(entry)
        return (
          <tr key={entry.job}>
            <td>
              <JobLabel entry={entry} />
            </td>
            <td>
              <details className={styles.breakdown}>
                <summary>
                  {entities.length} {entityNoun}
                  {lagging > 0 && <span className={styles.lagging}> · {lagging} lagging</span>}
                </summary>
                {offerRefreshAll && kickable === 'always' && entities.length > 1 && (
                  <div className={styles.breakdownActions}>
                    <RefreshAllButton job={entry.job} />
                  </div>
                )}
                <ul className={styles.breakdownList}>
                  {entities.map((entity) => (
                    <li key={entity.id}>
                      <span className={styles.breakdownName}>
                        <Name name={entity.name} />
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
                      <Cell job={entry.job} entity={entity} kickable={kickable} />
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
              <Freshness at={oldestRun(entities)} />
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
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const {
    registrations,
    characterEntities,
    corporationEntities,
    accountBeats,
    runFor,
    activity,
    corporationCount,
    anyActive,
    chancellor,
    now,
  } = await fetchJobsOverview(supabase, user.id)

  return (
    <>
      <h1>Extract jobs</h1>
      <p>
        Every job that feeds this site&apos;s data, when it last ran for you, and when it runs next. Schedules are UTC
        and come from the deployment&apos;s own cron configuration. Nothing starts just by opening this page — stale
        rows can be refreshed one at a time, and a refresh you kick shows up under Recent activity.
      </p>

      {registrations.length === 0 ? (
        <p>
          No characters registered yet. Add one on the <Link href="/character">Characters</Link> page.
        </p>
      ) : (
        <>
          <h2>Characters</h2>
          <p>
            Last run is <em>the oldest of your characters</em>&nbsp;— one character that hasn&apos;t pulled is what
            makes the data stale, even when the others just ran. Open a row for the per-character breakdown, and for the
            button that refreshes every character at once.
          </p>
          <EntityJobTable
            entries={jobsInSection('character')}
            entitiesByJob={characterEntities}
            entityNoun="characters"
            kickableOf={(entry) => entry.kickable}
            offerRefreshAll
          />

          {corporationCount > 0 && (
            <>
              <h2>Corporations</h2>
              <p>
                Corp extracts run once per corporation, under the token of a character holding the in-game role —
                director, accountant — that the endpoint requires. <em>Runs as</em> names whose token the last pull
                actually used, so a corp going stale because its only director token stopped working is visible as such.
                A corp where none of your characters holds the role reads <em>not a director</em>: nothing was pulled,
                but nothing failed either, and there is nothing to retry.
              </p>
              <EntityJobTable
                entries={jobsInSection('corporation')}
                entitiesByJob={corporationEntities}
                entityNoun="corporations"
                kickableOf={(entry) => entry.kickable}
                showRunsAs
              />
            </>
          )}
        </>
      )}

      <h2>Shared universe</h2>
      <p>
        Game-wide data every account shares — the SDE mirror, structure and name resolution, industry cost indices.
        These run once for everyone, so a run someone else kicked shows here as running for you too. Relative times
        only: a nightly job would sit permanently red against the six-hourly freshness scale. Kicking one of these is a
        Chancellor's call — the pull is game-wide, not yours.
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
            const beat = accountBeats.get(entry.job)
            const entity: EntityRun = { id: '', name: entry.label, ...runFor(entry.job, '', beat) }
            // industry-systems pulls the whole game's cost indices in one shot;
            // its on-demand kick stays a Chancellor tool (and refreshCell
            // re-checks server-side).
            const kickable = entry.kickable === 'chancellor' && !chancellor ? 'never' : entry.kickable
            return (
              <tr key={entry.job}>
                <td>
                  <JobLabel entry={entry} />
                </td>
                <td>
                  <Cell job={entry.job} entity={entity} kickable={kickable} showFreshness={false} />
                </td>
                <td>
                  <Status status={entity.status} error={entity.error} />
                </td>
                <td>
                  {isOverdue(entry.job, entity.lastRunAt) ? (
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

      <h2>Recent activity</h2>
      <p>
        Refreshes you kicked in the last 24 hours, newest first, grouped by the batch that dispatched them. This is the
        only place an on-demand run that failed while you were away is visible.
      </p>
      {activity.length === 0 ? (
        <p>Nothing kicked in the last 24 hours.</p>
      ) : (
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
            {activity.map((task) => (
              <tr key={task.id}>
                <td>{task.firstOfBatch ? relativeTime(task.created_at, now) : ''}</td>
                <td>
                  <code className={styles.jobName}>{task.job}</code>
                </td>
                <td>{task.character_name === null ? '—' : <Name name={task.character_name} />}</td>
                <td>
                  <Status status={isAbandoned(task, now) ? 'abandoned' : task.status} error={task.error} />
                  {task.error !== null && <div className={styles.errorText}>{task.error}</div>}
                </td>
                <td>{task.durationSeconds === null ? '—' : `${task.durationSeconds}s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <RefreshPoller done={!anyActive} />
    </>
  )
}

export default JobsPage
