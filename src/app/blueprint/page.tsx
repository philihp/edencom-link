import Link from 'next/link'
import { chain, filter, groupBy, isNil, map, reject, sort, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { characterSlug, pickMain } from '../bpos/slug'
import { TypeSearch } from './typeSearch'

// ESI hands this scope out only to a character holding the Director role in
// game, so a token carrying it is our one signal that a character is a
// director — and it is the same grant that makes the corporation's blueprints
// readable at all, which is exactly what the corp showcase renders.
const CORP_BLUEPRINTS_SCOPE = 'esi-corporations.read_blueprints.v1'

// One row in either list: where it goes and how it reads.
type Library = { key: string; href: string; label: string; note: string }

const libraryOf = (name: string, note: string, key: string): Library => ({
  key,
  href: `/bpos/${characterSlug(name)}`,
  label: name,
  note,
})

const byLabel = (a: Library, b: Library) => a.label.localeCompare(b.label)

// The blueprint libraries this account can open, in two lists: the ones that
// are OURS — our own originals pooled across characters, and the corporations
// we hold a director in — and below them the ones somebody else published to
// us. A corporation we are merely a member of sits in the second list: the
// library is the corporation's, not ours to keep, but membership is why we can
// see it, so it leads that list.
const BposLibraries = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return null

  const service = createServiceClient()

  // Our characters: the main names our own showcase, and their corporations are
  // the ones we have a character in.
  const { data: ownRegistrations } = await supabase
    .from('registration')
    .select('name, is_main, created_at, corporation_id')
  type OwnReg = {
    name: string
    is_main: boolean | null
    created_at: string | null
    corporation_id: number | string | null
  }
  const ownRegs = (ownRegistrations ?? []) as OwnReg[]
  const main = pickMain(ownRegs)
  const memberCorpIds = new Set(
    map(
      Number,
      reject(
        isNil,
        map((r: OwnReg) => r.corporation_id, ownRegs)
      )
    )
  )

  // Corporations we hold a DIRECTOR in. `token` is service-role-only (those are
  // live EVE refresh tokens), so the read is explicitly scoped to the caller.
  // The scope is our only signal, and it is the grant that fills corp_blueprint
  // in the first place.
  const { data: tokens } = await service
    .from('token')
    .select('registration_id')
    .eq('user_id', user.id)
    .contains('scope', [CORP_BLUEPRINTS_SCOPE])
    .returns<Array<{ registration_id: string }>>()
  const registrationIds = uniq(map((t: { registration_id: string }) => t.registration_id, tokens ?? []))
  const { data: directorRegs } = registrationIds.length
    ? await service
        .from('registration')
        .select('corporation_id')
        .in('id', registrationIds)
        .not('corporation_id', 'is', null)
        .returns<Array<{ corporation_id: number | string }>>()
    : { data: [] }
  const directorCorpIds = new Set(
    map((r: { corporation_id: number | string }) => Number(r.corporation_id), directorRegs ?? [])
  )

  // Published corporation libraries. Asked as the VIEWER, so corp_bpo_share's
  // own policies answer it: a member sees their corporation's row, and the
  // audience policy adds rows aimed at their corp or alliance plus any that are
  // fully public. A link-only share matches nobody, which is right — its URL is
  // the only way in.
  const { data: corpShares } = await supabase
    .from('corp_bpo_share')
    .select('corporation_id')
    .returns<Array<{ corporation_id: number | string }>>()
  const sharedCorpIds = uniq(
    map((r: { corporation_id: number | string }) => Number(r.corporation_id), corpShares ?? [])
  )

  // Other players' account libraries, published to us the same way. Our own row
  // is visible here too and is dropped: that library is already the first entry
  // of the list above.
  const { data: accountShares } = await supabase
    .from('bpo_share')
    .select('user_id')
    .returns<Array<{ user_id: string }>>()
  const sharedUserIds = reject(
    (id: string) => id === user.id,
    uniq(map((r: { user_id: string }) => r.user_id, accountShares ?? []))
  )

  // Names. A corporation the directory hasn't backfilled can't be addressed by
  // slug, so it is left out rather than linking nowhere; an account is
  // addressed by its main, resolved the same way our own is.
  const corpIds = uniq([...directorCorpIds, ...sharedCorpIds])
  const { data: corps } = corpIds.length
    ? await service
        .from('corporation')
        .select('corporation_id, name')
        .in('corporation_id', corpIds)
        .not('name', 'is', null)
        .returns<Array<{ corporation_id: number | string; name: string }>>()
    : { data: [] }
  const corpName = new Map(
    map(
      (c: { corporation_id: number | string; name: string }) => [Number(c.corporation_id), c.name] as [number, string],
      corps ?? []
    )
  )

  const { data: sharerRegs } = sharedUserIds.length
    ? await service
        .from('registration')
        .select('user_id, name, is_main, created_at')
        .in('user_id', sharedUserIds)
        .returns<Array<{ user_id: string; name: string; is_main: boolean | null; created_at: string | null }>>()
    : { data: [] }
  const mainByUser = new Map(
    chain(
      ([userId, regs = []]) => {
        const sharerMain = pickMain(regs)
        return sharerMain ? [[userId, sharerMain.name] as [string, string]] : []
      },
      Object.entries(groupBy((r: { user_id: string }) => r.user_id, sharerRegs ?? []))
    )
  )

  const corpLibrary = (id: number, note: string): Library[] => {
    const name = corpName.get(id)
    return name ? [libraryOf(name, note, `corp-${id}`)] : []
  }

  const mine: Library[] = [
    ...(main ? [libraryOf(main.name, 'every original across your characters', 'own')] : []),
    ...sort(
      byLabel,
      chain((id: number) => corpLibrary(id, 'every original in the corporation’s hangars'), [...directorCorpIds])
    ),
  ]

  // Membership first, since that is the closest of these to being ours.
  const shared: Library[] = [
    ...sort(
      byLabel,
      chain(
        (id: number) => corpLibrary(id, 'your corporation’s hangars'),
        filter((id: number) => memberCorpIds.has(id) && !directorCorpIds.has(id), sharedCorpIds)
      )
    ),
    ...sort(
      byLabel,
      chain(
        (id: number) => corpLibrary(id, 'another corporation’s hangars'),
        filter((id: number) => !memberCorpIds.has(id), sharedCorpIds)
      )
    ),
    ...sort(
      byLabel,
      chain((id: string) => {
        const name = mainByUser.get(id)
        return name ? [libraryOf(name, 'another player’s originals', `user-${id}`)] : []
      }, sharedUserIds)
    ),
  ]

  if (mine.length === 0 && shared.length === 0) return null

  const List = ({ heading, libraries }: { heading: string; libraries: Library[] }) => (
    <>
      <h2>{heading}</h2>
      <ul>
        {libraries.map((library) => (
          <li key={library.key}>
            <Link href={library.href}>{library.label}</Link> — {library.note}
          </li>
        ))}
      </ul>
    </>
  )

  return (
    <>
      {mine.length > 0 && <List heading="Your blueprint libraries" libraries={mine} />}
      {shared.length > 0 && <List heading="Shared with you" libraries={shared} />}
    </>
  )
}

const BlueprintPage = () => (
  <>
    <h1>Blueprint</h1>
    <p>Given a blueprint, this tool will tell you which Upwell rigs give it a bonus.</p>
    <TypeSearch />
    <BposLibraries />
  </>
)

export default BlueprintPage
