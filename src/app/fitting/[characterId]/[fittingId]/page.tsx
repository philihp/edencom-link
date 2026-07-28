import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { ShipFitViewDynamic } from '../../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { fetchTypeNames } from '../../../typeNames'
import { resolveFittingShareToken } from '../../access'
import { toEsiFit, type FittingItem, type FittingRow } from '../../fit'
import { ShareControls } from '../../shareControls'
import { SlotGroups } from '../../slotGroups'
import styles from '../../fittings.module.css'

// One saved fitting, rendered in the eveship.fit wheel.
//
// The route carries the owning registration's uuid as well as the fitting id
// because ESI numbers fittings per pilot (every character has a fitting 1), so
// the id alone identifies nothing. RLS still does the access control — a uuid
// belonging to another account matches no row.
//
// A `token` query param means "open via a character_fitting_share link"
// instead of "I am signed in as the owner" — mirroring
// src/app/ship/[itemId]/page.tsx's own token check, it always wins: whoever
// is looking (owner included) gets the read-only shared view, no login
// required. Drop the query param to get the owner view back.
const FittingDetailPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ characterId: string; fittingId: string }>
  searchParams: Promise<{ token?: string }>
}) => {
  const { characterId, fittingId } = await params
  const { token } = await searchParams

  if (token) return <SharedFitting characterId={characterId} fittingId={fittingId} token={token} />

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // One bulk SDE lookup covers the hull and every fitted type; the caller's
  // own existing share (if any) seeds ShareControls so a re-visit shows the
  // same link rather than a fresh "Share this fit" button.
  const [typeNames, { data: registration }, { data: share }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    supabase.from('registration').select('name').eq('id', characterId).maybeSingle<{ name: string }>(),
    supabase
      .from('character_fitting_share')
      .select('token')
      .eq('character_id', characterId)
      .eq('fitting_id', fittingId)
      .maybeSingle<{ token: string }>(),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  return (
    <>
      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name || `Fitting #${fit.fitting_id}`}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> — saved by <Name name={registration?.name ?? null} />
      </p>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      <ShareControls characterId={characterId} fittingId={fittingId} initialToken={share?.token ?? null} />

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </>
  )
}

export default FittingDetailPage

// Anonymous, token-gated view of one fit: no login, no RLS — every query runs
// on the service-role client, scoped explicitly to the exact (character_id,
// fitting_id) the token resolved to (see access.ts). Renders read-only (no
// ShareControls) with a "Shared by <owner>" credit floating top-right.
const SharedFitting = async ({
  characterId,
  fittingId,
  token,
}: {
  characterId: string
  fittingId: string
  token: string
}) => {
  const fit = await resolveFittingShareToken(token, characterId, fittingId)
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  const supabase = createServiceClient()
  const [typeNames, { data: registration }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    supabase
      .from('registration')
      .select('name, character_id')
      .eq('id', characterId)
      .maybeSingle<{ name: string | null; character_id: number | string | null }>(),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  return (
    <div className={styles.sharedPage}>
      <div className={styles.sharedFrom}>
        {registration?.character_id ? (
          <img
            className={styles.sharedFromAvatar}
            src={`https://images.evetech.net/characters/${registration.character_id}/portrait?size=64`}
            alt=""
          />
        ) : (
          <div className={styles.sharedFromAvatar} aria-hidden="true" />
        )}
        <span className={styles.sharedFromLabel}>
          Shared by <Name name={registration?.name ?? null} />
        </span>
      </div>

      <p className={styles.meta}>
        <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name || `Fitting #${fit.fitting_id}`}</h1>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </div>
  )
}
