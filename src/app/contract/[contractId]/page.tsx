import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { DateTime } from '../../DateTime'
import { formatIsk } from '../../isk'
import { Name } from '../../names'
import retro from '../../retro.module.css'
import { TypeIcon } from '../../typeIcon'
import {
  availabilityLabel,
  contractHeading,
  moneyLines,
  parseContractId,
  statusLabel,
  typeLabel,
  type ContractLine,
  type StatusStep,
} from './contract'
import styles from './contract.module.css'
import { loadContractPage, type ContractPageData } from './load'

// One contract that a character or corporation of the caller is party to, at
// /contract/[contractId]: its parties, places, ISK, items and status history.
// The /market table links each contract trade here. On the cookie session
// only; a contract the caller cannot read is a 404, so a guessed id confirms
// nothing.

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ contractId: string }>
}

const Party = ({ id, names }: { id: number | string | null; names: Record<number, string> }) =>
  id == null ? <>—</> : <Name name={names[Number(id)]} id={id} />

const Place = ({ id, names }: { id: number | string | null; names: Record<number, string> }) =>
  id == null ? <>—</> : <Link href={`/asset/${id}`}>{names[Number(id)] ?? `#${id}`}</Link>

const ItemsTable = ({ lines, types }: { lines: ContractLine[]; types: Record<number, string> }) => (
  <table className={retro.retro}>
    <thead>
      <tr>
        <th>Type</th>
        <th className={retro.num}>Qty</th>
      </tr>
    </thead>
    <tbody>
      {lines.map((l) => (
        <tr key={l.recordId}>
          <td>
            <span className={styles.typeCell}>
              <TypeIcon id={l.typeId} size={24} isBlueprintCopy={l.blueprint === 'copy'} />
              <span className="serif">{types[l.typeId] ?? `#${l.typeId}`}</span>
              {l.blueprint !== null ? <span className={retro.muted}>({l.blueprint})</span> : null}
            </span>
          </td>
          <td className={retro.num}>{l.quantity.toLocaleString('en-US')}</td>
        </tr>
      ))}
    </tbody>
  </table>
)

const HistoryTable = ({ steps }: { steps: StatusStep[] }) => (
  <table className={retro.retro}>
    <thead>
      <tr>
        <th>Status</th>
        <th>From</th>
        <th>Last seen</th>
      </tr>
    </thead>
    <tbody>
      {steps.map((s) => (
        <tr key={`${s.status}-${s.from}`}>
          <td>{statusLabel(s.status)}</td>
          <td>
            <DateTime value={s.from} />
          </td>
          <td>
            <DateTime value={s.until} />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
)

const Facts = ({ data }: { data: ContractPageData }) => {
  const { contract: c, parties, locations } = data
  return (
    <dl className={styles.facts}>
      <dt>Issuer</dt>
      <dd>
        <Party id={c.issuer_id} names={parties} />
        {' of '}
        <Party id={c.issuer_corporation_id} names={parties} />
        {c.for_corporation ? <span className={retro.muted}> (for the corporation)</span> : null}
      </dd>
      <dt>Availability</dt>
      <dd>
        {availabilityLabel(c.availability)}
        {c.assignee_id != null ? (
          <>
            {' to '}
            <Party id={c.assignee_id} names={parties} />
          </>
        ) : null}
      </dd>
      <dt>Acceptor</dt>
      <dd>
        <Party id={c.acceptor_id} names={parties} />
      </dd>
      <dt>{c.type === 'courier' ? 'Pick up' : 'Location'}</dt>
      <dd>
        <Place id={c.start_location_id} names={locations} />
      </dd>
      {c.type === 'courier' ? (
        <>
          <dt>Deliver to</dt>
          <dd>
            <Place id={c.end_location_id} names={locations} />
          </dd>
          <dt>Volume</dt>
          <dd>{c.volume == null ? '—' : `${Number(c.volume).toLocaleString('en-US')} m³`}</dd>
          <dt>Days to complete</dt>
          <dd>{c.days_to_complete ?? '—'}</dd>
        </>
      ) : null}
      <dt>Issued</dt>
      <dd>
        <DateTime value={c.date_issued} />
      </dd>
      <dt>Expires</dt>
      <dd>
        <DateTime value={c.date_expired} />
      </dd>
      <dt>Accepted</dt>
      <dd>
        <DateTime value={c.date_accepted} />
      </dd>
      <dt>Completed</dt>
      <dd>
        <DateTime value={c.date_completed} />
      </dd>
      <dt>Seen by</dt>
      <dd>
        <Name name={data.ownerName} />, <DateTime value={c.seen_at} />
      </dd>
    </dl>
  )
}

const ContractPage = async ({ params }: PageProps) => {
  const { contractId: raw } = await params
  const contractId = parseContractId(raw)
  if (contractId === null) notFound()

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')

  const data = await loadContractPage(supabase, contractId)
  if (data === null) notFound()
  const { contract: c, lines, history, types } = data
  const money = moneyLines(c)

  return (
    <>
      <section className={styles.identity}>
        <div className={styles.titleRow}>
          <h1 className={`${styles.title} serif`}>{contractHeading(c)}</h1>
          <span className={styles.badge}>{typeLabel(c.type)}</span>
          <span className={styles.badge}>{statusLabel(c.status)}</span>
        </div>
        <p className={styles.subtitle}>
          Contract {c.contract_id}
          {c.status_since != null ? (
            <>
              {' · '}
              {statusLabel(c.status).toLowerCase()} since <DateTime value={c.status_since} />
            </>
          ) : null}
        </p>
      </section>

      {money.length > 0 ? (
        <section className={styles.money} aria-label="ISK">
          {money.map((m) => (
            <div key={m.label} className={styles.stat}>
              <div className={styles.statLabel}>{m.label}</div>
              <div className={styles.statValue}>{formatIsk(m.isk)}</div>
            </div>
          ))}
        </section>
      ) : null}

      <section className={styles.block} aria-labelledby="contract-facts-heading">
        <h2 id="contract-facts-heading" className={styles.blockHeading}>
          Details
        </h2>
        <Facts data={data} />
      </section>

      <section className={styles.block} aria-labelledby="contract-offered-heading">
        <h2 id="contract-offered-heading" className={styles.blockHeading}>
          {c.type === 'courier' ? 'Cargo' : 'Items offered'}
        </h2>
        {lines.offered.length > 0 ? (
          <ItemsTable lines={lines.offered} types={types} />
        ) : (
          <p className={retro.muted}>No items on record.</p>
        )}
      </section>

      {lines.asked.length > 0 ? (
        <section className={styles.block} aria-labelledby="contract-asked-heading">
          <h2 id="contract-asked-heading" className={styles.blockHeading}>
            Items asked for
          </h2>
          <ItemsTable lines={lines.asked} types={types} />
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className={styles.block} aria-labelledby="contract-history-heading">
          <h2 id="contract-history-heading" className={styles.blockHeading}>
            Status history
          </h2>
          <HistoryTable steps={history} />
        </section>
      ) : null}
    </>
  )
}

export default ContractPage
