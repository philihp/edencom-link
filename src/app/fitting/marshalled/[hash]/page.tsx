import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../account/lib/establishedUser'
import { parseMarshalledHandle } from '../../../api/fittings/marshalledHandle'
import { DateTime } from '../../../DateTime'
import { Name } from '../../../names'
import { ShipViewDynamic } from '../../../ship/[itemId]/shipViewDynamic'
import { toEft, type EftType } from '../../eft'
import { EftExport } from '../../eftExport'
import { toEsiFit, type FittingItem } from '../../fit'
import { unmarshalTargets } from '../../marshal/slots'
import { fetchSlotUsage } from '../../marshal/targets'
import { UnmarshalControls } from '../../marshal/unmarshalControls'
import { SlotGroups } from '../../slotGroups'
import styles from '../../fittings.module.css'

// One marshalled fitting (docs/fitting-marshal.md): a fit the account holds
// here and no game client holds. Drawn by the same viewer as a saved fit —
// toEsiFit takes the archive row as it takes a character_fitting row — with
// the all-V baseline, since no pilot holds it, under a line saying where it
// came from.
//
// A static segment beside /fitting/[characterId]: Next resolves `marshalled`
// first, and resolveFittingOwner rejects a non-numeric first segment anyway,
// so nothing collides. Owner-only, by RLS on marshalled_fitting (the session
// reads its own rows and nobody else's). There is no share path and no
// signed link: the set of fits an account has marshalled is its own.
type MarshalledRow = {
  content_hash: string
  name: string
  description: string
  ship_type_id: number | string
  items: FittingItem[] | null
  source_registration_id: string | null
  source_fitting_id: number | string | null
  write_log_id: number | string | null
  marshalled_at: string
}

const MarshalledFittingPage = async ({ params }: { params: Promise<{ hash: string }> }) => {
  const hash = parseMarshalledHandle((await params).hash)
  if (hash === null) notFound()

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('marshalled_fitting')
    .select(
      'content_hash, name, description, ship_type_id, items, source_registration_id, source_fitting_id, write_log_id, marshalled_at'
    )
    .eq('content_hash', hash)
    .maybeSingle<MarshalledRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []
  const [sdeTypes, usage, source] = await Promise.all([
    getSdeTypes([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    fetchSlotUsage(supabase),
    // The character it came from, while still on the account (RLS on
    // `registration`; the column nulls when the character is unlinked).
    fit.source_registration_id
      ? supabase
          .from('registration')
          .select('name')
          .eq('id', fit.source_registration_id)
          .maybeSingle<{ name: string | null }>()
          .then((r) => r.data)
      : Promise.resolve(null),
  ])
  const entries = Object.values(sdeTypes)
  const types: Record<number, EftType> = Object.fromEntries(
    entries.map((t) => [t.typeID, { name: t.name, categoryID: t.categoryID }])
  )
  const typeNames: Record<number, string> = Object.fromEntries(entries.map((t) => [t.typeID, t.name]))
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`
  const name = fit.name || 'Unnamed fitting'

  return (
    <div>
      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1>{name}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> —{' '}
        {fit.write_log_id != null ? (
          <>
            marshalled from {source?.name ? <Name name={source.name} /> : 'a character no longer linked'} on{' '}
            <DateTime value={fit.marshalled_at} />
          </>
        ) : (
          <>
            added from a file on <DateTime value={fit.marshalled_at} />
          </>
        )}
      </p>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      <div className={styles.shareRow}>
        <UnmarshalControls contentHash={fit.content_hash} fitName={name} targets={unmarshalTargets(usage)} />
      </div>

      <ShipViewDynamic esiFit={toEsiFit(fit)} pilot={null} />

      <SlotGroups items={items} typeNames={typeNames} />

      <EftExport eft={toEft(fit, types)} />
    </div>
  )
}

export default MarshalledFittingPage
