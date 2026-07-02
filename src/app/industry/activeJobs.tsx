'use client'

import { useEffect, useState } from 'react'

import { DateTime } from '../DateTime'
import { Name } from '../names'
import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../ownerFilter'
import retro from '../retro.module.css'
import { TypeName } from '../typeName'
import styles from './industry.module.css'
import { ACTIVITY_NAMES } from './jobFields'

export type Job = {
  job_id: number | string
  // Character registration uuid, or corporation id for corp jobs.
  owner_id: string
  activity_id: number
  blueprint_type_id: number | string
  product_type_id: number | string | null
  runs: number
  status: string
  start_date: string
  end_date: string
  station_id: number | string | null
  facility_id: number | string | null
}

type ActiveJobsProps = {
  jobs: Job[]
  owners: Owners
  initialNow: number
  typeNamesPromise: Promise<Record<number, string>>
  stationNames: Record<string, string>
}

const OWNER_STORAGE_KEY = 'industry.activeJobs.ownerId'

const formatRemaining = (endIso: string, now: number) => {
  const ms = new Date(endIso).getTime() - now
  if (ms <= 0) return 'ready'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export const ActiveJobs = ({ jobs, owners, initialNow, typeNamesPromise, stationNames }: ActiveJobsProps) => {
  const ownerName = ownerNames(owners)

  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)

  const filtered = jobs.filter((j) => ownerId === ALL_OWNERS || j.owner_id === ownerId)

  const [now, setNow] = useState<number>(initialNow)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <section>
      <div className={styles.jobsHeader}>
        <h2>Active Jobs</h2>
      </div>
      {jobs.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>
                <label className={styles.jobsFilter}>
                  Owner:&nbsp;
                  <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
                </label>
              </th>
              <th>Activity</th>
              <th>Product</th>
              <th className={retro.num}>Runs</th>
              <th>Station</th>
              <th>Start</th>
              <th>End</th>
              <th>Remaining</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((j) => (
              <tr key={`job-${j.job_id}`}>
                <td>
                  <Name name={ownerName.get(j.owner_id)} />
                </td>
                <td className="serif">{ACTIVITY_NAMES[j.activity_id] ?? `#${j.activity_id}`}</td>
                <td>
                  {j.product_type_id != null ? (
                    <TypeName id={Number(j.product_type_id)} promise={typeNamesPromise} />
                  ) : (
                    '—'
                  )}
                </td>
                <td className={retro.num}>{j.runs}</td>
                <td className="serif">
                  {(() => {
                    const stationId = j.station_id ?? j.facility_id
                    if (stationId == null) return '—'
                    const name = stationNames[String(stationId)]
                    return name ? <a href={`/structure/${stationId}`}>{name}</a> : String(stationId)
                  })()}
                </td>
                <td>
                  <DateTime value={j.start_date} />
                </td>
                <td>
                  <DateTime value={j.end_date} />
                </td>
                <td className="serif">{formatRemaining(j.end_date, now)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              // Keep the table (and the owner dropdown in its header) rendered
              // so the filter can be changed back when an owner has no jobs.
              <tr>
                <td colSpan={8}>No active jobs for this owner.</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p>No active industry jobs.</p>
      )}
    </section>
  )
}
