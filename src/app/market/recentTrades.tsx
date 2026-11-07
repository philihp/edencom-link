'use client'

import { filter, pipe } from 'ramda'
import { useMemo } from 'react'

import { DateTime } from '../DateTime'
import { formatIskValue } from '../isk'
import { Name } from '../names'
import { TypeName } from '../typeName'
import { usePersist } from '../usePersist'
import { inWindow, tradeValue } from './aggregate'
import { contractLabel } from './contracts'
import { byWho, capitalize, counterpartyLabel, parseWho, SIDE_COPY, whoOptions } from './sides'
import type { ContractDetail, Side, Trade } from './trade'
import styles from './market.module.css'

type Character = {
  id: string
  name: string
}

type RecentTradesProps = {
  // Server-anchored "now" (epoch ms) shared with the overview, so the table and
  // the tiles cover exactly the same window.
  now: number
  // The active tab. The view gives only the trades on this side.
  side: Side
  trades: Trade[]
  characters: Character[]
  // corporation_id → name, for our corporation trades (falls back to a raw id).
  corpNames: Record<number, string>
  // client_id → name, for the counterparty (falls back to a raw id).
  counterpartyNames: Record<number, string>
  typeNamesPromise: Promise<Record<number, string>>
  windowDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000
// Item names under a contract label before the rest is a count.
const CONTRACT_NAMES = 2

// A contract row: "Contract · N items" with a tag, then the title, or else
// the first item names.
const ContractCell = ({
  contract,
  typeNamesPromise,
}: {
  contract: ContractDetail
  typeNamesPromise: Promise<Record<number, string>>
}) => {
  const rest = contract.items.length - CONTRACT_NAMES
  return (
    <>
      {contractLabel(contract.items)} <span className={styles.sourceTag}>[ contract ]</span>
      <span className={styles.contractDetail}>
        {contract.title ??
          contract.items.slice(0, CONTRACT_NAMES).map((item, i) => (
            <span key={`${item.type_id}-${i}`}>
              {i > 0 ? ', ' : ''}
              <TypeName id={item.type_id} promise={typeNamesPromise} />
            </span>
          ))}
        {contract.title === null && rest > 0 ? ` and ${rest} more` : ''}
      </span>
    </>
  )
}

const THRESHOLDS: Array<{ label: string; value: number }> = [
  { label: 'All', value: 0 },
  { label: '≥ 1M ISK', value: 1_000_000 },
  { label: '≥ 10M ISK', value: 10_000_000 },
  { label: '≥ 100M ISK', value: 100_000_000 },
  { label: '≥ 1B ISK', value: 1_000_000_000 },
]

const THRESHOLD_STORAGE_KEY = 'market.recentSales.threshold'
// One saved "Who" per side: a buyer is not a seller.
const whoStorageKey = (side: Side) => `market.recentTrades.who.${side}`
const ALL = ''

export const RecentTrades = ({
  now,
  side,
  trades,
  characters,
  corpNames,
  counterpartyNames,
  typeNamesPromise,
  windowDays,
}: RecentTradesProps) => {
  const copy = SIDE_COPY[side]
  const characterName: Record<string, string> = Object.fromEntries(characters.map((c) => [c.id, c.name]))
  const windowLabel = `${windowDays} day${windowDays === 1 ? '' : 's'}`
  const nameOf = counterpartyLabel(counterpartyNames)

  // Our side of the trade: the character or the corporation that made it.
  const ourLabel = (t: Trade): string | null => {
    if (t.registration_id) return characterName[t.registration_id] ?? null
    if (t.corporation_id != null) return corpNames[t.corporation_id] ?? `Corp #${t.corporation_id}`
    return null
  }

  const inView = useMemo(
    () => filter(inWindow(now - windowDays * DAY_MS, Number.POSITIVE_INFINITY), trades),
    [trades, now, windowDays]
  )
  const options = useMemo(() => whoOptions(counterpartyNames, inView), [counterpartyNames, inView])

  const [threshold, setThreshold] = usePersist(THRESHOLD_STORAGE_KEY, 0, (raw) => {
    const parsed = Number(raw)
    return THRESHOLDS.some((t) => t.value === parsed) ? parsed : undefined
  })

  const [savedWho, setWho] = usePersist<number | null>(whoStorageKey(side), null, parseWho)
  // A saved counterparty with no trade in this window reads as "everyone", so
  // the select never shows a value it has no option for.
  const who = savedWho !== null && options.some((o) => o.clientId === savedWho) ? savedWho : null

  const shown = pipe(
    byWho(who),
    filter((t: Trade) => tradeValue(t) >= threshold)
  )(inView)

  return (
    <section>
      <div className={styles.salesHeader}>
        <h2>
          Recent {copy.noun} (last {windowLabel})
        </h2>
        <div className={styles.salesFilters}>
          <label className={styles.salesFilter}>
            Who:&nbsp;
            <select
              value={who === null ? ALL : String(who)}
              onChange={(e) => setWho(e.target.value === ALL ? null : Number(e.target.value))}
            >
              <option value={ALL}>All {copy.counterparty}s</option>
              {options.map((o) => (
                <option key={o.clientId} value={o.clientId}>
                  {o.label} ({formatIskValue(o.total)})
                </option>
              ))}
            </select>
          </label>
          <label className={styles.salesFilter}>
            Filter:&nbsp;
            <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
              {THRESHOLDS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {shown.length > 0 ? (
        <table className={styles.sales}>
          <thead>
            <tr>
              <th>{capitalize(copy.counterparty)}</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Unit (ISK)</th>
              <th>Total (ISK)</th>
              <th>{capitalize(copy.verb)}</th>
              <th>Seen</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={`${t.source}-${side}-${t.transaction_id}`}>
                <td>
                  <Name name={nameOf(t.client_id)} />
                </td>
                <td>
                  {t.contract === null ? (
                    <TypeName id={t.type_id} promise={typeNamesPromise} />
                  ) : (
                    <ContractCell contract={t.contract} typeNamesPromise={typeNamesPromise} />
                  )}
                </td>
                <td>{t.contract === null ? t.quantity : '—'}</td>
                <td>{t.contract === null ? formatIskValue(t.unit_price) : '—'}</td>
                <td>{formatIskValue(tradeValue(t))}</td>
                <td>
                  <DateTime value={t.date} />
                </td>
                <td>
                  <DateTime value={t.seen_at} />
                </td>
                <td>
                  <Name name={ourLabel(t)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No {copy.noun} match this filter.</p>
      )}
    </section>
  )
}
