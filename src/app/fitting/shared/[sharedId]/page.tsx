import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ShipFitViewDynamic } from '../../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { fetchTypeNames } from '../../../typeNames'
import { unpublishFitting } from '../../actions'
import { toEsiFit, type FittingItem } from '../../fit'
import { SlotGroups } from '../../slotGroups'
import styles from '../../fittings.module.css'

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

// One corp/alliance fitting published on the site, in the eveship.fit wheel.
// RLS does the access control: the select policy only returns fits published
// to a corp or alliance the caller has a character in.
const SharedFittingPage = async ({ params }: { params: Promise<{ sharedId: string }> }) => {
  const { sharedId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('shared_fitting')
    .select('id, audience, corporation_id, alliance_id, name, description, ship_type_id, items, created_by')
    .eq('id', sharedId)
    .maybeSingle<SharedFitting>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // Audience name from the world-readable directory tables; publisher name via
  // character_directory (registration uuid → public identity, no user_id).
  const [typeNames, { data: audienceRow }, { data: publisher }, { data: ownRegistrations }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    fit.audience === 'corporation'
      ? supabase.from('corporation').select('name').eq('corporation_id', fit.corporation_id).maybeSingle()
      : supabase.from('alliance').select('name').eq('alliance_id', fit.alliance_id).maybeSingle(),
    fit.created_by
      ? supabase.from('character_directory').select('name').eq('registration_id', fit.created_by).maybeSingle()
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
    <>
      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> — {audienceLabel} fitting for <Name name={audienceName} />, published by{' '}
        <Name name={(publisher as { name: string | null } | null)?.name ?? null} />
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
    </>
  )
}

export default SharedFittingPage
