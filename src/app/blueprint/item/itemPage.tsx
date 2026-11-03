import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { match } from 'ts-pattern'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { DateTime } from '../../DateTime'
import { formatIsk } from '../../isk'
import retro from '../../retro.module.css'
import { MemoryPanel } from '../../ship/memory/memoryPanel'
import { readShipMemory } from '../../ship/memory/read'
import { TypeIcon } from '../../typeIcon'
import { type Made, type RunRow } from './history'
import styles from './item.module.css'
import { loadBlueprintPage, type BlueprintPageData } from './load'
import { type Origin, originMemory } from './origin'

// One blueprint the caller holds — an original or a copy — at
// /blueprint/[itemId] (docs/item-pages.md): what it is, every run it has
// made and what those add up to, where a copy came from, and the memory it
// keeps. Holder-only, on the cookie session; a blueprint the caller cannot
// read is a 404, so a guessed id confirms nothing.

const ORIGIN_AUTHOR = 'origin'

// The one memory the server writes itself: a copy's origin, stored the first
// time the holder looks, so the next look reads it back instead of inferring
// again. Best-effort through the one write path, item_memory_write(), under
// RLS — a refusal (the viewer is an author reading a sold copy, say) leaves
// the page showing the inference it computed.
const storeOriginMemory = async (
  supabase: Awaited<ReturnType<typeof createClient>>,
  data: BlueprintPageData
): Promise<BlueprintPageData> => {
  if (data.memory != null || !data.item.held || data.origin == null) return data
  const body = originMemory(data.origin, {
    typeName: data.names.types[data.item.typeId] ?? null,
    locationName:
      'locationId' in data.origin && data.origin.locationId != null
        ? (data.names.locations[data.origin.locationId] ?? null)
        : null,
  })
  if (body == null) return data
  const { error } = await supabase.rpc('item_memory_write', {
    p_item_id: data.item.itemId,
    p_body: body,
    p_based_on: null,
    p_author: ORIGIN_AUTHOR,
  })
  if (error) return data
  return { ...data, memory: await readShipMemory(supabase, data.item.itemId) }
}

const MadeCell = ({ made, types }: { made: Made; types: Record<number, string> }) => {
  const name = (id: number | null) => (id == null ? '—' : (types[id] ?? `#${id}`))
  return match(made)
    .with({ kind: 'units' }, (m) => (
      <>
        <span className={retro.num}>{m.quantity.toLocaleString('en-US')}</span> × {name(m.typeId)}
      </>
    ))
    .with({ kind: 'copies' }, (m) => (
      <>
        <span className={retro.num}>{m.copies.toLocaleString('en-US')}</span> {m.copies === 1 ? 'copy' : 'copies'}
        {m.licensedRuns != null ? (
          <span className={retro.muted}> of {m.licensedRuns.toLocaleString('en-US')} runs</span>
        ) : null}
      </>
    ))
    .with({ kind: 'invented' }, (m) => (
      <>
        <span className={retro.num}>{m.successes == null ? '?' : m.successes}</span>
        <span className={retro.muted}> of {m.attempts}</span> {name(m.typeId)}
      </>
    ))
    .with({ kind: 'research' }, (m) => (
      <>
        <span className={retro.num}>{m.levels}</span> {m.levels === 1 ? 'level' : 'levels'}
      </>
    ))
    .with({ kind: 'other' }, (m) => (
      <>
        <span className={retro.num}>{m.runs}</span> runs
      </>
    ))
    .exhaustive()
}

const LocationCell = ({ id, names }: { id: string | null; names: Record<string, string> }) =>
  id == null ? <>—</> : <Link href={`/asset/${id}`}>{names[id] ?? `#${id}`}</Link>

const OriginBlock = ({ origin, names }: { origin: Origin; names: BlueprintPageData['names'] }) => {
  const text = match(origin)
    .with({ kind: 'predates' }, () => 'Already in the hangar when the record began, so its past is before our time.')
    .with({ kind: 'unknown' }, () => 'No copy or invention job of ours finished in the window before it appeared.')
    .with({ kind: 'copied' }, { kind: 'invented' }, (o) => (
      <>
        {o.kind === 'copied' ? 'Copied' : 'Invented'} in job {o.jobId}
        {o.locationId != null ? (
          <>
            {' '}
            at <LocationCell id={o.locationId} names={names.locations} />
          </>
        ) : null}
        , delivered <DateTime value={o.deliveredAt} />: {o.copies.toLocaleString('en-US')}{' '}
        {o.kind === 'copied' ? (o.copies === 1 ? 'copy' : 'copies') : o.copies === 1 ? 'attempt' : 'attempts'}
        {o.licensedRuns != null ? ` of ${o.licensedRuns} runs` : ''}.
        {o.confidence === 'medium' ? (
          <span className={retro.muted}> {o.candidates} such jobs finished around then; this was the nearest.</span>
        ) : null}
      </>
    ))
    .exhaustive()
  return (
    <section className={styles.block} aria-labelledby="blueprint-origin-heading">
      <h2 id="blueprint-origin-heading" className={styles.blockHeading}>
        Origin
      </h2>
      <p className={styles.blockBody}>{text}</p>
    </section>
  )
}

const RunsTable = ({ rows, names }: { rows: RunRow[]; names: BlueprintPageData['names'] }) =>
  rows.length === 0 ? (
    <p className={retro.muted}>No job on record ran this blueprint.</p>
  ) : (
    <table className={retro.retro}>
      <thead>
        <tr>
          <th>Where</th>
          <th>Activity</th>
          <th>Made</th>
          <th>Started</th>
          <th>Ended</th>
          <th>Status</th>
          <th className={retro.num}>EIV</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.jobId} className={r.counted ? undefined : styles.uncounted}>
            <td>
              <LocationCell id={r.locationId} names={names.locations} />
            </td>
            <td>{r.activityName}</td>
            <td>
              <MadeCell made={r.made} types={names.types} />
            </td>
            <td>
              <DateTime value={r.start} />
            </td>
            <td>
              <DateTime value={r.end} />
            </td>
            <td>{r.status}</td>
            <td className={retro.num}>
              {r.eiv == null ? (
                '—'
              ) : r.eivExact ? (
                formatIsk(r.eiv)
              ) : (
                <span title="Installed before the price record began; priced at the earliest adjusted price on record">
                  ≈ {formatIsk(r.eiv)}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )

export const BlueprintItemPage = async ({ itemId }: { itemId: number }) => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')

  const loaded = await loadBlueprintPage(supabase, itemId)
  if (loaded == null) notFound()
  const data = await storeOriginMemory(supabase, loaded)
  const { item, rows, totals, product, origin, memory, names } = data

  const typeName = names.types[item.typeId] ?? `#${item.typeId}`
  const productName = product == null ? null : (names.types[product.productTypeID] ?? `#${product.productTypeID}`)

  return (
    <>
      <section className={styles.identity}>
        <TypeIcon id={item.typeId} size={64} categoryID={item.type?.categoryID} isBlueprintCopy={item.isCopy} />
        <div className={styles.main}>
          <div className={styles.titleRow}>
            <h1 className={`${styles.title} serif`}>{typeName}</h1>
            <span className={styles.badge}>{item.isCopy ? 'copy' : 'original'}</span>
          </div>
          <p className={styles.subtitle}>
            ME {item.me ?? '—'} · TE {item.te ?? '—'}
            {item.runsLeft != null ? <> · {item.runsLeft.toLocaleString('en-US')} runs left</> : null}
            {productName != null ? <> · builds {productName}</> : null}
          </p>
          <p className={styles.subtitle}>
            {item.owner.name}
            {item.locationId != null ? (
              <>
                {' '}
                · <LocationCell id={String(item.locationId)} names={names.locations} />
              </>
            ) : null}
            {' · '}
            {item.held ? (
              <>
                in the hangar, seen <DateTime value={item.lastSeen} />
              </>
            ) : (
              <span className={styles.gone}>
                no longer held, last seen <DateTime value={item.lastSeen} />
              </span>
            )}
          </p>
        </div>
      </section>

      <section className={styles.totals} aria-label="Totals">
        <div className={styles.stat}>
          <div className={styles.statLabel}>EIV produced</div>
          <div className={styles.statValue}>{formatIsk(totals.eivProduced)}</div>
          <div className={styles.statNote}>
            {totals.pricedRuns} {totals.pricedRuns === 1 ? 'run' : 'runs'}
            {totals.unpricedRuns > 0 ? `, ${totals.unpricedRuns} unpriced` : ''}
            {' · '}at CCP's adjusted prices as each run was installed
            {totals.approximateRuns > 0
              ? `; ${totals.approximateRuns} from before the price record began, at its earliest price`
              : ''}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Copies made</div>
          <div className={styles.statValue}>{totals.copies.toLocaleString('en-US')}</div>
          <div className={styles.statNote}>{totals.licensedRuns.toLocaleString('en-US')} licensed runs in all</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Research</div>
          <div className={styles.statValue}>{totals.researchLevels.toLocaleString('en-US')}</div>
          <div className={styles.statNote}>levels gained</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Invention</div>
          <div className={styles.statValue}>
            {totals.inventionSuccesses.toLocaleString('en-US')}
            <span className={styles.statOf}> / {totals.inventionAttempts.toLocaleString('en-US')}</span>
          </div>
          <div className={styles.statNote}>successes over attempts</div>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="blueprint-runs-heading">
        <h2 id="blueprint-runs-heading" className={styles.blockHeading}>
          Runs
        </h2>
        <RunsTable rows={rows} names={names} />
      </section>

      {origin != null ? <OriginBlock origin={origin} names={names} /> : null}

      <MemoryPanel memory={memory} keeps="blueprint" />
    </>
  )
}
