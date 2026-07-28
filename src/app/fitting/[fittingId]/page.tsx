import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ShipFitViewDynamic } from '../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../names'
import { fetchTypeNames } from '../../typeNames'
import { publishFitting, unpublishFitting } from '../actions'
import { parseFittingRouteParam, toEsiFit, type FittingItem, type FittingRow } from '../fit'
import { SlotGroups } from '../slotGroups'
import styles from '../fittings.module.css'

type SharedFitting = {
  id: string
  audience: 'corporation' | 'alliance'
  corporation_id: number | null
  alliance_id: number | null
  name: string
  description: string | null
  ship_type_id: number | string
  items: FittingItem[] | null
  created_by: string | null
}

// One saved fitting, rendered in the eveship.fit wheel — personal or
// published, both at the same /fitting/[fittingId] URL shape (see
// parseFittingRouteParam in fit.ts for how the one param carries either kind).
const FittingDetailPage = async ({ params }: { params: Promise<{ fittingId: string }> }) => {
  const { fittingId: routeParam } = await params
  const route = parseFittingRouteParam(routeParam)
  if (!route) notFound()

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  if (route.kind === 'shared') return <SharedFitting supabase={supabase} sharedId={route.sharedId} />
  return <PersonalFitting supabase={supabase} characterId={route.characterId} fittingId={route.fittingId} />
}

export default FittingDetailPage

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

// The route carries the owning registration's uuid as well as the fitting id
// because ESI numbers fittings per pilot (every character has a fitting 1), so
// the id alone identifies nothing. RLS still does the access control — a uuid
// belonging to another account matches no row.
const PersonalFitting = async ({
  supabase,
  characterId,
  fittingId,
}: {
  supabase: SupabaseClient
  characterId: string
  fittingId: string
}) => {
  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // One bulk SDE lookup covers the hull and every fitted type. The owning
  // registration's corp (and its alliance, via the world-readable corporation
  // row) decides which publish targets exist.
  const [typeNames, { data: registration }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    supabase
      .from('registration')
      .select('name, corporation_id')
      .eq('id', characterId)
      .maybeSingle<{ name: string; corporation_id: number | null }>(),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  const { data: corporation } = registration?.corporation_id
    ? await supabase
        .from('corporation')
        .select('name, alliance_id')
        .eq('corporation_id', registration.corporation_id)
        .maybeSingle<{ name: string | null; alliance_id: number | null }>()
    : { data: null }

  const publishToCorp = publishFitting.bind(null, characterId, fittingId, 'corporation')
  const publishToAlliance = publishFitting.bind(null, characterId, fittingId, 'alliance')

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

      {registration?.corporation_id != null ? (
        // Publishing copies this fit into the site's corp/alliance doctrine
        // list (shared_fitting) — a snapshot, not a live link; the in-game
        // fitting folders aren't touched (ESI has no write path we use).
        <div className={styles.publishRow}>
          <form action={publishToCorp}>
            <button type="submit" className={styles.publishButton}>
              Publish to corp{corporation?.name ? ` (${corporation.name})` : ''}
            </button>
          </form>
          {corporation?.alliance_id != null ? (
            <form action={publishToAlliance}>
              <button type="submit" className={styles.publishButton}>
                Publish to alliance
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </>
  )
}

// A corp/alliance fitting published on the site. RLS does the access control:
// the select policy only returns fits published to a corp or alliance the
// caller has a character in.
const SharedFitting = async ({ supabase, sharedId }: { supabase: SupabaseClient; sharedId: string }) => {
  const { data: fit } = await supabase
    .from('shared_fitting')
    .select('id, audience, corporation_id, alliance_id, name, description, ship_type_id, items, created_by')
    .eq('id', sharedId)
    .maybeSingle<SharedFitting>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // Audience name from the world-readable directory tables; publisher name +
  // portrait via character_directory (registration uuid → public identity, no
  // user_id — the sharing-layer identity split), which is also where the
  // publisher's EVE character_id (for the ESI image server) comes from.
  const [typeNames, { data: audienceRow }, { data: publisher }, { data: ownRegistrations }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    fit.audience === 'corporation'
      ? supabase.from('corporation').select('name').eq('corporation_id', fit.corporation_id).maybeSingle()
      : supabase.from('alliance').select('name').eq('alliance_id', fit.alliance_id).maybeSingle(),
    fit.created_by
      ? supabase
          .from('character_directory')
          .select('name, character_id')
          .eq('registration_id', fit.created_by)
          .maybeSingle<{ name: string | null; character_id: number | string }>()
      : Promise.resolve({ data: null }),
    supabase.from('registration').select('id'),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`
  const audienceLabel = fit.audience === 'corporation' ? 'Corporation' : 'Alliance'
  const audienceName =
    (audienceRow as { name: string | null } | null)?.name ??
    `#${fit.audience === 'corporation' ? fit.corporation_id : fit.alliance_id}`

  // The publisher (any of the caller's own registrations) can take it down.
  const canUnpublish = fit.created_by != null && (ownRegistrations ?? []).some((r) => r.id === fit.created_by)
  const unpublish = unpublishFitting.bind(null, fit.id)

  return (
    <div className={styles.sharedPage}>
      {publisher ? (
        <div className={styles.sharedFrom}>
          {publisher.character_id ? (
            <img
              className={styles.sharedFromAvatar}
              src={`https://images.evetech.net/characters/${publisher.character_id}/portrait?size=64`}
              alt=""
            />
          ) : (
            <div className={styles.sharedFromAvatar} aria-hidden="true" />
          )}
          <span className={styles.sharedFromLabel}>
            Shared from <Name name={publisher.name} />
          </span>
        </div>
      ) : null}

      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> — {audienceLabel} fitting for <Name name={audienceName} />
      </p>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}
      {canUnpublish ? (
        <form action={unpublish}>
          <button type="submit" className={styles.publishButton}>
            Unpublish
          </button>
        </form>
      ) : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </div>
  )
}
