'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { DateTime } from '../DateTime'
import { LinkSpinner } from '../linkSpinner'
import { ALL_OWNERS, OwnerSelect, ownerNames, useExcludedCorps, useOwnerFilter, type Owners } from '../ownerFilter'
import { usePersist } from '../usePersist'
import { WindowSelect } from '../windowSelect'
import { formatMoment, formatMonth, formatRange } from './chartTime'
import styles from './industry.module.css'
import { ACTIVITY_NAMES } from './jobFields'
import {
  formatCompactIsk,
  formatRemaining,
  inScope,
  jobsInView,
  jobsListedInWindow,
  OPEN_STATUSES,
  progressAt,
  rateSegments,
  runningAt,
  summarizeRate,
  type LiftJob,
  type LiftScope,
} from './lift'
import { LiftChart } from './liftChart'
import {
  DEFAULT_INDUSTRY_WINDOW_DAYS,
  INDUSTRY_WINDOW_STORAGE_KEY,
  parseIndustryWindowDays,
  windowRange,
} from './windows'

// The /industry page below its data: the lift-rate chart over the whole job
// history, and the job list under it — the jobs that ran in the window the
// chart shows, or the jobs that were running at a moment the chart has been
// scoped to. One owner filter scopes both, and the window dropdown top-right
// (the Market/Structures control) takes chart and list straight to a trailing
// span; scrolling the chart makes the window "custom", and the list follows
// the chart either way (docs/design-system/Industry.dc.html).

type IndustryViewProps = {
  jobs: readonly LiftJob[]
  owners: Owners
  typeNames: Readonly<Record<number, string>>
  stationNames: Readonly<Record<string, string>>
  // The server's clock at render, so the first paint agrees on both sides;
  // the client ticks from there.
  initialNow: number
  // Manufacturing/reaction jobs whose bill could not be priced.
  unpriced: number
  // The price lookup itself failed, so every job is unpriced for that reason.
  pricingFailed: boolean
}

const OWNER_STORAGE_KEY = 'industry.activeJobs.ownerId'
const EXCLUDED_CORPS_STORAGE_KEY = 'industry.activeJobs.excludedCorpIds'

const DAY = 86_400_000
// How far the floor sits before the oldest job, and the ceiling past now.
const FLOOR_MARGIN = 3 * DAY
const CEILING_AHEAD = 14 * DAY

const SCOPES: Array<{ key: LiftScope; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'manufacturing', label: 'manufacturing' },
  { key: 'reaction', label: 'reaction' },
]

export const IndustryView = ({
  jobs,
  owners,
  typeNames,
  stationNames,
  initialNow,
  unpriced,
  pricingFailed,
}: IndustryViewProps) => {
  const ownerName = ownerNames(owners)

  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [excludedCorpIds, setExcludedCorpIds] = useExcludedCorps(EXCLUDED_CORPS_STORAGE_KEY, owners)
  const toggleCorp = (id: string) =>
    setExcludedCorpIds(
      excludedCorpIds.includes(id) ? excludedCorpIds.filter((x) => x !== id) : [...excludedCorpIds, id]
    )

  const [now, setNow] = useState<number>(initialNow)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const [scope, setScope] = useState<LiftScope>('all')
  // The window: the remembered span (usePersist applies the saved one after
  // mount, so the first frame agrees on both sides of hydration), and whether
  // the chart has since been zoomed or panned off it — then the dropdown reads
  // "custom" until the next pick. The range follows the span whenever the span
  // is in charge; the chart's own gestures set the range directly.
  const [windowDays, setWindowDays] = usePersist(
    INDUSTRY_WINDOW_STORAGE_KEY,
    DEFAULT_INDUSTRY_WINDOW_DAYS,
    parseIndustryWindowDays
  )
  const [custom, setCustom] = useState(false)
  const [range, setRange] = useState<{ t0: number; t1: number }>(() =>
    windowRange(DEFAULT_INDUSTRY_WINDOW_DAYS, initialNow)
  )
  useEffect(() => {
    if (!custom) setRange(windowRange(windowDays, Date.now()))
  }, [windowDays, custom])
  const selectWindow = (days: number) => {
    setCustom(false)
    setWindowDays(days)
  }
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [scopeT, setScopeT] = useState<number | null>(null)

  const visible = jobs.filter((j) => {
    if (ownerId !== ALL_OWNERS) return j.ownerId === ownerId
    return !excludedCorpIds.includes(j.ownerId)
  })

  const oldest = visible.reduce((m, j) => Math.min(m, j.start), Number.POSITIVE_INFINITY)
  const minT = (Number.isFinite(oldest) ? oldest : now) - FLOOR_MARGIN
  const maxT = now + CEILING_AHEAD

  const openJobs = visible.filter((j) => OPEN_STATUSES.has(j.status) && j.start <= now)
  const nowJobs = runningAt(visible, now, scope)
  const nowRate = nowJobs.reduce((sum, j) => sum + (j.rate ?? 0), 0)
  const inView = jobsInView(visible, range.t0, range.t1, scope)
  const summary = summarizeRate(rateSegments(visible, range.t0, range.t1, scope))

  // The list: jobs running at the scoped moment under the chart's scope, or
  // every job that ran in the window the chart shows, regardless of family —
  // research is listed, just unmeasured.
  const scoped = scopeT != null
  const listed = scoped
    ? runningAt(visible, scopeT, scope)
        .slice()
        .sort((a, b) => a.end - b.end)
    : jobsListedInWindow(visible, range.t0, range.t1)

  const productName = (j: LiftJob) => {
    const id = j.productTypeId ?? j.blueprintTypeId
    return typeNames[id] ?? `#${id}`
  }

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>industry</h1>
          <div className={styles.subtitle}>
            <span className={styles.mono}>{openJobs.length}</span> active jobs ·{' '}
            <span className={styles.mono}>{visible.length.toLocaleString('en-US')}</span> on record
            {Number.isFinite(oldest) && (
              <>
                {' '}
                since <span className={styles.mono}>{formatMonth(oldest)}</span>
              </>
            )}
          </div>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.headerControl}>
            <span className={styles.headerControlLabel}>Window</span>
            <WindowSelect days={windowDays} custom={custom} onChange={selectWindow} />
          </span>
          <div className={styles.caption}>
            prices: Jita split at install · fees included · shipping ignored
            {pricingFailed ? (
              <> · price lookup failed; nothing priced</>
            ) : (
              unpriced > 0 && (
                <>
                  {' '}
                  · <span className={styles.mono}>{unpriced}</span> {unpriced === 1 ? 'job' : 'jobs'} unpriced
                </>
              )
            )}
          </div>
        </div>
      </div>

      <section className={styles.panel} aria-label="Lift rate">
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>lift rate</span>
          <span className={styles.bracket}>
            [
            {SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={scope === s.key ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle}
                onClick={() => setScope(s.key)}
              >
                {s.label}
              </button>
            ))}
            <span className={styles.toggleOff} title="lift for research is not measured yet">
              research · soon
            </span>
            ]
          </span>
          <span className={styles.spacer} />
          <span className={styles.faint}>now</span>
          <span className={styles.nowRate}>{formatCompactIsk(nowRate)}</span>
          <span className={styles.faint}>
            ISK/hr · <span className={styles.mono}>{nowJobs.length}</span> jobs
          </span>
        </div>
        <div className={styles.chartRow}>
          <LiftChart
            jobs={visible}
            scope={scope}
            t0={range.t0}
            t1={range.t1}
            minT={minT}
            maxT={maxT}
            now={now}
            hoverT={hoverT}
            scopeT={scopeT}
            typeNames={typeNames}
            onRange={(t0, t1) => {
              setRange({ t0, t1 })
              setCustom(true)
            }}
            onHover={setHoverT}
            onScope={setScopeT}
          />
          <dl className={styles.summary} aria-label="Lift over the window shown">
            <div>
              <dt>median</dt>
              <dd>
                {formatCompactIsk(summary?.median)} <span className={styles.summaryUnit}>ISK/hr</span>
              </dd>
            </div>
            <div>
              <dt>average</dt>
              <dd>
                {formatCompactIsk(summary?.average)} <span className={styles.summaryUnit}>ISK/hr</span>
              </dd>
            </div>
            <div>
              <dt>total</dt>
              <dd>
                {formatCompactIsk(summary?.total)} <span className={styles.summaryUnit}>ISK</span>
              </dd>
            </div>
          </dl>
        </div>
        <div className={styles.panelFoot}>
          <span>
            showing <span className={styles.mono}>{formatRange(range.t0, range.t1)}</span>
          </span>
          <span className={styles.mono}>{inView.length} jobs in view</span>
          <span className={styles.spacer} />
          <span>scroll to zoom · shift-scroll to pan</span>
          <button
            type="button"
            className={`${styles.toggle} ${styles.small}`}
            onClick={() => selectWindow(DEFAULT_INDUSTRY_WINDOW_DAYS)}
          >
            reset range
          </button>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.listPanel}`} aria-label="Jobs">
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>{scoped ? 'jobs at scoped moment' : 'jobs in window'}</span>
          {scoped ? (
            <>
              <span className={styles.soft}>
                — jobs running at <span className={styles.mono}>{formatMoment(scopeT)}</span>
              </span>
              <button type="button" className={styles.toggle} onClick={() => setScopeT(null)}>
                back to the window
              </button>
            </>
          ) : (
            <span className={styles.soft}>
              — <span className={styles.mono}>{listed.length}</span> {listed.length === 1 ? 'job' : 'jobs'} in{' '}
              <span className={styles.mono}>{formatRange(range.t0, range.t1)}</span>
            </span>
          )}
          <span className={styles.spacer} />
          <label className={styles.ownerFilter}>
            owner: <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
          </label>
        </div>
        {ownerId === ALL_OWNERS && owners.corporations.length > 0 && (
          <div className={styles.corpToggles}>
            Include Corporate Jobs:
            {owners.corporations.map((c) => (
              <label key={c.id} className={styles.corpToggle}>
                <input type="checkbox" checked={!excludedCorpIds.includes(c.id)} onChange={() => toggleCorp(c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        )}
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>owner</th>
                <th>activity</th>
                <th>product</th>
                <th className={styles.num}>runs</th>
                <th>station</th>
                <th className={styles.num}>lift</th>
                <th className={styles.num}>ISK/hr</th>
                <th>start</th>
                <th>end</th>
                <th>{scoped ? 'progress then' : 'remaining'}</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((j) => {
                const measured = inScope(j, 'all')
                const remaining = formatRemaining(j.end, now)
                return (
                  <tr key={j.id} className={styles.row}>
                    <td>{ownerName.get(j.ownerId) ?? `#${j.ownerId}`}</td>
                    <td className={styles.soft}>{ACTIVITY_NAMES[j.activityId] ?? `#${j.activityId}`}</td>
                    <td>{productName(j)}</td>
                    <td className={styles.num}>{j.runs}</td>
                    <td>
                      {j.stationId == null ? (
                        '—'
                      ) : stationNames[j.stationId] ? (
                        <Link href={`/structure/${j.stationId}`} className={styles.stationLink}>
                          {stationNames[j.stationId]}
                          <LinkSpinner />
                        </Link>
                      ) : (
                        <span className={styles.mono}>{j.stationId}</span>
                      )}
                    </td>
                    <td className={styles.num}>{measured ? formatCompactIsk(j.lift) : '—'}</td>
                    <td className={`${styles.num} ${styles.strong}`}>{measured ? formatCompactIsk(j.rate) : '—'}</td>
                    <td className={styles.when}>
                      <DateTime value={j.start} />
                    </td>
                    <td className={styles.when}>
                      <DateTime value={j.end} />
                    </td>
                    {scoped ? (
                      <td className={styles.soft}>{progressAt(j, scopeT)}% through</td>
                    ) : OPEN_STATUSES.has(j.status) ? (
                      <td className={remaining === 'ready' ? styles.ready : undefined}>{remaining}</td>
                    ) : (
                      <td className={styles.soft}>{j.status}</td>
                    )}
                  </tr>
                )
              })}
              {listed.length === 0 && (
                <tr>
                  <td colSpan={10} className={styles.empty}>
                    {scoped
                      ? 'No jobs were running at that moment.'
                      : visible.length === 0
                        ? 'No industry jobs on record for this owner.'
                        : 'No industry jobs ran in this window.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
