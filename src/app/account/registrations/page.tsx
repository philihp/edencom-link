// /registration — one page for the linked characters and the extract jobs that
// keep their data fresh (docs/registrations-page). Laid out per the phase-0
// design extraction: a page header over one bordered matrix whose cells fuse
// grant and job — one cell answers both "may we pull this" and "when did we".
//
// Phase 3+4: the per-scope job columns with the four grant states, the axis
// refresh triggers (cell / column / row / everything), the template row, the
// corporation matrix, and the /jobs sections parity keeps below the fold
// (shared universe, recent activity, poller). /character and /jobs stay live
// and unchanged until a separate sunset decision.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { CSSProperties } from 'react'
import { reduce } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'
import { register } from '../../character/actions'
import { fetchCharacterOverviews, hasNoOptionalScopes } from '../../character/characterData'
import { JobSlots } from '../../character/jobSlotBubbles'
import { freshnessLevel, relativeTime } from '../../freshness'
import { formatBisk } from '../../isk'
import { type Registration, fetchJobsOverview } from '../../jobs/jobsData'
import { NextRun } from '../../jobs/nextRun'
import { RefreshPoller } from '../../jobs/poller'
import { type JobEntry, isOverdue, jobsInSection, nextRunFor } from '../../jobs/registry'
import { type EntityRun, isAbandoned, newestRun } from '../../jobs/rows'
import { Name } from '../../names'
import {
  type GrantState,
  blockedCellCount,
  columnGrant,
  grantAllowsRun,
  soonestNextRun,
  templateCheck,
  trailingScopes,
} from './matrix'
import { CellKick, ColumnKick, RefreshAll, Retry, RowKick, TemplateToggle, UniverseKick } from './matrixButtons'
import { fetchGrantOverview } from './matrixData'
import styles from './registration.module.css'

// The poller re-requests this server component while a kicked job is in
// flight, so never serve it from the router cache.
export const dynamic = 'force-dynamic'

const iso = (at: Date | null) => (at === null ? null : at.toISOString())

const STATUS_LABEL: Record<string, string> = {
  running: '● running',
  queued: '· queued',
  failed: '✗ failed',
  skipped: '— not a director',
  idle: 'idle',
  pending: '· pending',
  done: '✓ done',
  error: '✗ error',
  abandoned: '✗ abandoned',
}

const GRANT_GLYPH: Record<GrantState, string> = { on: '✓', missing: '✕', extra: '✓', off: '·' }

const GRANT_TITLE: Record<GrantState, string> = {
  on: 'Requested and granted — this job runs',
  missing: 'Requested but not granted — this job never runs; re-auth to grant it',
  extra: 'Granted but not in the request template — still refreshes',
  off: 'Neither requested nor granted',
}

// One matrix cell: the grant icon over the job's last-run state. The four base
// states come from the grant; running/failed overlay them (failure is
// orthogonal to grant state — a granted pull can still die on a dead token).
const MatrixCell = ({
  job,
  label,
  entity,
  grant,
  kickable,
  now,
  runsAs,
}: {
  job: string
  label: string
  entity: EntityRun
  grant: GrantState
  kickable: boolean
  now: number
  // Corp cells: whose token the last pull ran under (or null when a corpmate's).
  runsAs?: { name: string | null; corpmate: boolean }
}) => {
  const inFlight = entity.status === 'running' || entity.status === 'queued'
  const runnable = grantAllowsRun(grant)
  // Same offer rule as /jobs's Cell: kickable, nothing in flight, nothing
  // skipped, and only once the data is off green or the last run failed.
  const offerKick =
    kickable &&
    runnable &&
    !inFlight &&
    entity.status !== 'skipped' &&
    (entity.status === 'failed' || freshnessLevel(entity.lastRunAt, now) !== 'fresh')
  return (
    <span className={styles.cell} data-grant={grant}>
      <span className={styles.cellLabel}>{label}</span>
      <span className={styles.grantIcon} data-grant={grant} title={GRANT_TITLE[grant]}>
        {GRANT_GLYPH[grant]}
      </span>
      <span className={styles.cellBody}>
        {entity.status === 'skipped' ? (
          <span className={styles.cellNote} title={entity.error ?? undefined}>
            — not a director
          </span>
        ) : inFlight ? (
          <span className={styles.cellRunning}>{entity.status === 'queued' ? 'queued…' : 'running…'}</span>
        ) : entity.status === 'failed' ? (
          <span className={styles.cellFailed} title={entity.error ?? undefined}>
            failed{entity.lastRunAt !== null && ` ${relativeTime(entity.lastRunAt, now)}`}
            {kickable && runnable && (
              <>
                {' · '}
                <Retry job={job} characterId={entity.id} />
              </>
            )}
          </span>
        ) : !runnable ? (
          <span className={grant === 'missing' ? styles.cellBlocked : styles.cellOff}>
            {grant === 'missing' ? 'never — no grant' : '—'}
          </span>
        ) : (
          <span className={styles.cellTime} data-fresh={freshnessLevel(entity.lastRunAt, now)}>
            {entity.lastRunAt === null ? 'never' : relativeTime(entity.lastRunAt, now)}
          </span>
        )}
        {runsAs && entity.status !== 'skipped' && (
          <span className={styles.cellRunsAs}>
            {runsAs.corpmate ? 'a corpmate’s token' : runsAs.name === null ? '' : `as ${runsAs.name}`}
          </span>
        )}
      </span>
      {offerKick && <CellKick job={job} characterId={entity.id} title={`Refresh ${label} now`} />}
    </span>
  )
}

// A column's header: the job label over its sweep button and its next
// scheduled fire (or the overdue flag when the previous one didn't happen).
const ColumnHead = ({ entry, entities, sweep }: { entry: JobEntry; entities: EntityRun[]; sweep: boolean }) => (
  <span className={styles.columnHead}>
    <span className={styles.columnLabel} title={entry.job}>
      {entry.label}
    </span>
    {sweep && <ColumnKick job={entry.job} label={entry.label} />}
    {isOverdue(entry.job, newestRun(entities)) ? (
      <span className={styles.overdue} title="The previous scheduled fire didn't produce a run">
        overdue
      </span>
    ) : (
      <span className={styles.columnNext}>
        <NextRun at={iso(nextRunFor(entry.job))} />
      </span>
    )}
  </span>
)

const RegistrationPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const [{ characters, status, statusText, error }, noOptionalScopes, jobs] = await Promise.all([
    fetchCharacterOverviews(supabase),
    hasNoOptionalScopes(supabase, user.id),
    fetchJobsOverview(supabase, user.id),
  ])
  const { grantedByRegistration, template } = await fetchGrantOverview(
    supabase,
    user.id,
    jobs.registrations.map((r) => r.id)
  )

  const characterJobs = jobsInSection('character')
  const corporationJobs = jobsInSection('corporation')
  const overviewById = new Map(characters.map((c) => [c.id, c]))
  const entityById = (job: string) => new Map((jobs.characterEntities[job] ?? []).map((e) => [e.id, e]))
  const cellsByJob = new Map(characterJobs.map((entry) => [entry.job, entityById(entry.job)]))

  const granted = (id: string) => grantedByRegistration.get(id) ?? new Set<string>()
  // Everything a re-auth would catch up, per registration; non-empty = the
  // character's grants trail the template.
  const trailing = new Map(jobs.registrations.map((r) => [r.id, trailingScopes(template, granted(r.id))]))
  const reauthCount = jobs.registrations.filter((r) => (trailing.get(r.id)?.length ?? 0) > 0).length

  // The legend's warn summary counts every requested-but-ungranted cell.
  const blocked = blockedCellCount(
    jobs.registrations.flatMap((r) => characterJobs.map((entry) => columnGrant(entry.scopes, granted(r.id), template)))
  )

  // One countdown for the page: the soonest next fire across the per-character
  // jobs (each column's own sits in its header).
  const nextSweep = soonestNextRun(characterJobs.map((entry) => nextRunFor(entry.job)))

  const requestedColumns = characterJobs.filter((entry) => templateCheck(entry.scopes, template) === 'all').length

  const columnStyle = { '--cols': characterJobs.length } as CSSProperties
  const corpColumnStyle = { '--cols': corporationJobs.length } as CSSProperties

  // The caller's corporations with their registered members, in registration
  // order — the same grouping and order jobsData builds corporationEntities
  // from, so the row at index i here is the entity at index i there.
  const corpList = [
    ...reduce(
      (acc, r: Registration) => {
        if (r.corporation_id == null) return acc
        const group = acc.get(r.corporation_id)
        if (group) group.push(r)
        else acc.set(r.corporation_id, [r])
        return acc
      },
      new Map<number, Registration[]>(),
      jobs.registrations
    ).entries(),
  ]

  // The template row is live even before the first character — the empty state
  // is the matrix, ghosted, with the request template already editable.
  const templateRow = (
    <div className={`${styles.row} ${styles.templateRow}`} style={columnStyle}>
      <div className={styles.templateLabel}>
        <span className={styles.templateTitle}>
          {characters.length === 0 ? 'Your first request will ask for' : 'Next request asks for'}
        </span>
        <span className={styles.templateSub}>
          {characters.length === 0
            ? 'adjust before you register — you grant only what’s checked'
            : 'what you grant when you register'}
        </span>
      </div>
      {characterJobs.map((entry) => (
        <span key={entry.job} className={styles.cell}>
          <span className={styles.cellLabel}>{entry.label}</span>
          <TemplateToggle scopes={entry.scopes} check={templateCheck(entry.scopes, template)} label={entry.label} />
        </span>
      ))}
      <span className={styles.templateCount}>
        {requestedColumns} of {characterJobs.length}
      </span>
    </div>
  )

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h1>Registrations &amp; refresh</h1>
          <div className={styles.status}>
            <span className={styles.statusCount}>{characters.length}</span>{' '}
            {characters.length === 1 ? 'character' : 'characters'}
            {reauthCount > 0 && (
              <>
                {' · '}
                <span className={styles.statusWarn}>
                  {reauthCount} need{reauthCount === 1 ? 's' : ''} re-auth
                </span>
              </>
            )}
            {nextSweep !== null && (
              <>
                {' · next scheduled sweep '}
                <NextRun at={iso(nextSweep)} />
              </>
            )}
          </div>
        </div>
        <div className={styles.headerActions}>
          {characters.length > 0 && <RefreshAll />}
          <form className={styles.registerForm}>
            <button formAction={register}>+ Register a character</button>
          </form>
        </div>
      </div>

      {noOptionalScopes && (
        <div className={styles.warning} role="alert">
          <strong className={styles.warningTitle}>Limited access selected</strong>
          <p className={styles.warningBody}>
            You haven&apos;t enabled any ESI permissions, so characters you add will only be identified — no wallet,
            assets, industry, market, or structure data can be tracked. Choose what to share in{' '}
            <Link href="/settings/grants">settings</Link>.
          </p>
        </div>
      )}

      <div className={styles.matrixScroll}>
        <div className={styles.matrix}>
          <div className={`${styles.headerRow} ${styles.row}`} style={columnStyle}>
            <span className={styles.columnLabel}>Character</span>
            {characterJobs.map((entry) => (
              <ColumnHead
                key={entry.job}
                entry={entry}
                entities={jobs.characterEntities[entry.job] ?? []}
                sweep={characters.length > 1 && entry.kickable === 'always'}
              />
            ))}
            <span className={styles.columnLabel}>All jobs</span>
          </div>

          {templateRow}

          {characters.length === 0 ? (
            <>
              {/* The empty state is the matrix, ghosted: one dashed row where
                  the first character will appear, so the CTA doesn't have to
                  explain what registering unlocks — the grid already does. */}
              <div className={`${styles.row} ${styles.ghostRow}`} style={columnStyle} aria-hidden="true">
                <div className={styles.identity}>
                  <div className={styles.ghostAvatar} />
                  <div className={styles.ghostBar} />
                </div>
                {characterJobs.map((entry) => (
                  <span key={entry.job} className={styles.cell}>
                    <span className={styles.ghostCell} />
                  </span>
                ))}
                <span />
              </div>
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>No characters registered yet</div>
                <p className={styles.emptyBody}>
                  Register one through EVE&apos;s SSO and this row fills in — refresh jobs start within a minute of the
                  grant.
                </p>
                <form className={styles.emptyActions}>
                  <button formAction={register}>Register your first character</button>
                </form>
                <div className={styles.reassurance}>
                  Uses CCP&apos;s official login — we never see your password.{' '}
                  <Link href="/settings/grants">What each scope unlocks</Link>
                </div>
              </div>
            </>
          ) : (
            jobs.registrations.map((r) => {
              const overview = overviewById.get(r.id)
              const scopes = granted(r.id)
              const trails = (trailing.get(r.id)?.length ?? 0) > 0
              return (
                <div key={r.id} className={styles.row} style={columnStyle}>
                  <div className={styles.identity}>
                    {overview?.characterId ? (
                      <img
                        className={styles.avatar}
                        src={`https://images.evetech.net/characters/${overview.characterId}/portrait?size=128`}
                        alt={r.name}
                      />
                    ) : (
                      <div className={styles.avatar} aria-hidden="true" />
                    )}
                    <div className={styles.identityText}>
                      <div className={styles.name}>{r.name}</div>
                      {trails ? (
                        <div className={styles.subline}>
                          <span className={styles.sublineWarn}>grants trail the template</span>
                          {' · '}
                          <form className={styles.reauthForm}>
                            <button formAction={register} className={styles.reauth}>
                              re-auth
                            </button>
                          </form>
                        </div>
                      ) : (
                        <div className={styles.subline}>
                          {r.corporation_id !== null &&
                            (jobs.corporationNames.get(r.corporation_id) ?? `#${r.corporation_id}`)}
                          {r.corporation_id !== null && r.is_main && ' · '}
                          {r.is_main && 'main'}
                        </div>
                      )}
                      {overview?.slots && <JobSlots counts={overview.slots.counts} max={overview.slots.max} />}
                      {overview && (
                        <details className={styles.stateDetails}>
                          <summary>details</summary>
                          <div className={styles.state}>
                            <div className={styles.field}>
                              <span className={styles.fieldLabel}>ISK:</span>
                              {overview.balance === null ? '—' : formatBisk(overview.balance)}
                            </div>
                            <div className={styles.field}>
                              <span className={styles.fieldLabel}>Location:</span>
                              {overview.locationSystem ?? '—'}
                            </div>
                            <div className={styles.field}>
                              <span className={styles.fieldLabel}>Ship:</span>
                              {overview.ship ? (
                                <Link href={`/ship/${overview.ship.itemId}`}>{overview.ship.label}</Link>
                              ) : (
                                '—'
                              )}
                            </div>
                            {overview.cloneSystems.length > 0 && (
                              <div className={styles.field}>
                                <span className={styles.fieldLabel}>Clone systems:</span>
                                <ul className={`${styles.list} ${styles.cloneList}`}>
                                  {overview.cloneSystems.map((system) => (
                                    <li key={system}>{system}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {overview.implants.length > 0 && (
                              <div className={styles.field}>
                                <span className={styles.fieldLabel}>Implants:</span>
                                <ul className={styles.list}>
                                  {overview.implants.map((name: string, i: number) => (
                                    <li key={i}>{name}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                  {characterJobs.map((entry) => (
                    <MatrixCell
                      key={entry.job}
                      job={entry.job}
                      label={entry.label}
                      entity={
                        cellsByJob.get(entry.job)?.get(r.id) ?? {
                          id: r.id,
                          name: r.name,
                          lastRunAt: null,
                          status: 'idle',
                          error: null,
                        }
                      }
                      grant={columnGrant(entry.scopes, scopes, template)}
                      kickable={entry.kickable === 'always'}
                      now={jobs.now}
                    />
                  ))}
                  <span className={styles.rowTail}>
                    <RowKick characterId={r.id} name={r.name} />
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className={styles.legend}>
        <span>
          <span className={styles.grantIcon} data-grant="on">
            ✓
          </span>{' '}
          requested + granted
        </span>
        <span>
          <span className={styles.grantIcon} data-grant="missing">
            ✕
          </span>{' '}
          requested, missing — job never runs
        </span>
        <span>
          <span className={styles.grantIcon} data-grant="extra">
            ✓
          </span>{' '}
          granted, not requested — still refreshes
        </span>
        <span>
          <span className={styles.grantIcon} data-grant="off">
            ·
          </span>{' '}
          neither
        </span>
        {blocked > 0 && (
          <span className={styles.legendBlocked}>
            {blocked} job{blocked === 1 ? '' : 's'} blocked by missing grants
          </span>
        )}
      </div>

      {/* Narrow widths lose the column headers, so the scope sweeps move into
          this disclosure (the mockup's bottom sheet, as a plain details). */}
      {characters.length > 1 && (
        <details className={styles.sweepSheet}>
          <summary>Refresh a scope everywhere</summary>
          <ul className={styles.sweepList}>
            {characterJobs
              .filter((entry) => entry.kickable === 'always')
              .map((entry) => (
                <li key={entry.job}>
                  <span>{entry.label}</span>
                  <span className={styles.sweepCount}>×{characters.length}</span>
                  <ColumnKick job={entry.job} label={entry.label} />
                </li>
              ))}
          </ul>
        </details>
      )}

      {jobs.corporationCount > 0 && (
        <>
          <h2>Corporations</h2>
          <p className={styles.sectionIntro}>
            Corp extracts run once per corporation, under the token of a character holding the in-game role — director,
            accountant — that the endpoint requires. Each cell names whose token the last pull actually used, so a corp
            going stale because its only director token stopped working is visible as such. A cell reading{' '}
            <em>not a director</em> pulled nothing, but failed nothing either — there is nothing to retry.
          </p>
          <div className={styles.matrixScroll}>
            <div className={styles.matrix}>
              <div className={`${styles.headerRow} ${styles.row}`} style={corpColumnStyle}>
                <span className={styles.columnLabel}>Corporation</span>
                {corporationJobs.map((entry) => (
                  <ColumnHead
                    key={entry.job}
                    entry={entry}
                    entities={jobs.corporationEntities[entry.job] ?? []}
                    sweep={false}
                  />
                ))}
                <span />
              </div>
              {corpList.map(([corporationId, members], corpIndex) => {
                // The corp's granted set is the union of its member tokens —
                // any member's grant makes the pull possible (the in-game role
                // check is EVE's, visible here as the skipped state).
                const memberGranted = new Set(members.flatMap((m) => [...granted(m.id)]))
                return (
                  <div key={corporationId} className={styles.row} style={corpColumnStyle}>
                    <div className={styles.identity}>
                      <div className={styles.identityText}>
                        <div className={styles.name}>
                          <Name name={jobs.corporationNames.get(corporationId)} id={corporationId} />
                        </div>
                        <div className={styles.subline}>
                          {members.length} of your character{members.length === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                    {corporationJobs.map((entry) => {
                      const entity = (jobs.corporationEntities[entry.job] ?? [])[corpIndex]
                      if (!entity) return <span key={entry.job} />
                      return (
                        <MatrixCell
                          key={entry.job}
                          job={entry.job}
                          label={entry.label}
                          entity={entity}
                          grant={columnGrant(entry.scopes, memberGranted, template)}
                          kickable={entry.kickable === 'always'}
                          now={jobs.now}
                          runsAs={{ name: entity.runsAs ?? null, corpmate: entity.runsAsCorpmate === true }}
                        />
                      )
                    })}
                    <span />
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      <h2>Shared universe</h2>
      <p className={styles.sectionIntro}>
        Game-wide data every account shares — the SDE mirror, structure and name resolution, industry cost indices.
        These run once for everyone, so a run someone else kicked shows here as running for you too. Relative times
        only: a nightly job would sit permanently red against the six-hourly freshness scale. Kicking one of these is a
        Chancellor&apos;s call — the pull is game-wide, not yours.
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
            const beat = jobs.accountBeats.get(entry.job)
            const entity: EntityRun = { id: '', name: entry.label, ...jobs.runFor(entry.job, '', beat) }
            const inFlight = entity.status === 'running' || entity.status === 'queued'
            const kick = entry.kickable === 'chancellor' && jobs.chancellor && !inFlight
            return (
              <tr key={entry.job}>
                <td>
                  {entry.label}
                  <code className={styles.jobName}>{entry.job}</code>
                </td>
                <td>
                  {entity.lastRunAt === null ? '—' : relativeTime(entity.lastRunAt, jobs.now)}
                  {kick && <UniverseKick job={entry.job} label={entry.label} />}
                </td>
                <td>
                  <span className={styles.statusCell} data-status={entity.status} title={entity.error ?? undefined}>
                    {STATUS_LABEL[entity.status] ?? entity.status}
                  </span>
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
      <p className={styles.sectionIntro}>
        Refreshes you kicked in the last 24 hours, newest first, grouped by the batch that dispatched them. This is the
        only place an on-demand run that failed while you were away is visible.
      </p>
      {jobs.activity.length === 0 ? (
        <p className={styles.sectionIntro}>Nothing kicked in the last 24 hours.</p>
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
            {jobs.activity.map((task) => (
              <tr key={task.id}>
                <td>{task.firstOfBatch ? relativeTime(task.created_at, jobs.now) : ''}</td>
                <td>
                  <code className={styles.jobName}>{task.job}</code>
                </td>
                <td>{task.character_name === null ? '—' : <Name name={task.character_name} />}</td>
                <td>
                  <span className={styles.statusCell} data-status={task.status} title={task.error ?? undefined}>
                    {STATUS_LABEL[isAbandoned(task, jobs.now) ? 'abandoned' : task.status] ?? task.status}
                  </span>
                  {task.error !== null && <div className={styles.errorText}>{task.error}</div>}
                </td>
                <td>{task.durationSeconds === null ? '—' : `${task.durationSeconds}s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && (
        <>
          <strong>
            {status}: {statusText}
          </strong>
          <br />
          <em>
            {error.code}: {error.message}
          </em>
          <pre>{JSON.stringify(error, undefined, 2)}</pre>
        </>
      )}

      <RefreshPoller done={!jobs.anyActive} />
    </>
  )
}
export default RegistrationPage
