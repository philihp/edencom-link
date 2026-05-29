'use client'

import { useEffect, useState } from 'react'

import { usePersist } from '../market/usePersist'
import retro from '../retro.module.css'
import styles from './industry.module.css'

export type Job = {
  job_id: number | string
  character_id: string
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

type Character = {
  id: string
  name: string
}

type ActiveJobsProps = {
  jobs: Job[]
  characters: Character[]
  initialNow: number
  typeNames: Record<number, string>
}

const ACTIVITY_NAMES: Record<number, string> = {
  1: 'Manufacturing',
  3: 'TE Research',
  4: 'ME Research',
  5: 'Copying',
  7: 'Reverse Engineering',
  8: 'Invention',
  9: 'Reactions',
}

const CHARACTER_STORAGE_KEY = 'industry.activeJobs.characterId'
const ALL_CHARACTERS = ''

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))

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

export const ActiveJobs = ({ jobs, characters, initialNow, typeNames }: ActiveJobsProps) => {
  const characterName: Record<string, string> = Object.fromEntries(characters.map((c) => [c.id, c.name]))

  const [characterId, setCharacterId] = usePersist<string>(CHARACTER_STORAGE_KEY, ALL_CHARACTERS, (raw) =>
    raw === ALL_CHARACTERS || characters.some((c) => c.id === raw) ? raw : undefined
  )

  const filtered = jobs.filter((j) => characterId === ALL_CHARACTERS || j.character_id === characterId)

  const [now, setNow] = useState<number>(initialNow)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <section>
      <div className={styles.jobsHeader}>
        <h2>Active Jobs</h2>
        <div className={styles.jobsFilters}>
          <label className={styles.jobsFilter}>
            Character:&nbsp;
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
              <option value={ALL_CHARACTERS}>All characters</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {filtered.length > 0 ? (
        <>
          <table className={retro.retro} border={3} cellPadding={4} cellSpacing={2}>
            <caption>~*~ Active Industry Jobs ~*~</caption>
            <thead>
              <tr>
                <th>Character</th>
                <th>Activity</th>
                <th>Blueprint</th>
                <th>Product</th>
                <th>Runs</th>
                <th>Station ID</th>
                <th>Start</th>
                <th>End</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <tr key={`job-${j.job_id}`}>
                  <td>{characterName[j.character_id] ?? '—'}</td>
                  <td>{ACTIVITY_NAMES[j.activity_id] ?? `#${j.activity_id}`}</td>
                  <td>{typeNames[Number(j.blueprint_type_id)] ?? `#${j.blueprint_type_id}`}</td>
                  <td>
                    {j.product_type_id != null
                      ? (typeNames[Number(j.product_type_id)] ?? `#${j.product_type_id}`)
                      : '—'}
                  </td>
                  <td>{j.runs}</td>
                  <td className={retro.id}>
                    {(j.station_id ?? j.facility_id) != null ? String(j.station_id ?? j.facility_id) : '—'}
                  </td>
                  <td>{formatDate(j.start_date)}</td>
                  <td>{formatDate(j.end_date)}</td>
                  <td>{formatRemaining(j.end_date, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={retro.bestViewedIn}>Best viewed in Netscape Navigator 3.0 at 800&times;600</p>
        </>
      ) : (
        <p>No active industry jobs.</p>
      )}
    </section>
  )
}
