import Link from 'next/link'
import { uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

import { characterSlug } from '../bpos/slug'
import { TypeSearch } from './typeSearch'

// ESI hands this scope out only to a character holding the Director role in
// game, so a token carrying it is our one signal that a character is a
// director — and it is the same grant that makes the corporation's blueprints
// readable at all, which is exactly what the corp showcase renders.
const CORP_BLUEPRINTS_SCOPE = 'esi-corporations.read_blueprints.v1'

// The signed-in user's own showcase lives under their main character's name,
// derived the same way the header labels them (flagged main first, then their
// earliest character).
const OwnBposLink = async () => {
  const supabase = await createClient()
  const { data: main } = await supabase
    .from('registration')
    .select('name')
    .order('is_main', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ name: string }>()
  if (!main?.name) return null
  return (
    <p>
      <Link href={`/bpos/${characterSlug(main.name)}`}>Your blueprint originals</Link> — a shareable showcase of every
      original across your characters.
    </p>
  )
}

// A corporation's originals live in its hangars, not any character's, so they
// get their own showcase — one link per corporation this account has a director
// in. Read through the service role, explicitly scoped to the caller: `token`
// is service-role-only (those are live EVE refresh tokens), so a session client
// cannot ask which scopes it holds.
const CorpBposLinks = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return null

  const service = createServiceClient()

  const { data: tokens } = await service
    .from('token')
    .select('registration_id')
    .eq('user_id', user.id)
    .contains('scope', [CORP_BLUEPRINTS_SCOPE])
    .returns<Array<{ registration_id: string }>>()
  const registrationIds = uniq((tokens ?? []).map((t) => t.registration_id))
  if (registrationIds.length === 0) return null

  const { data: regs } = await service
    .from('registration')
    .select('corporation_id')
    .in('id', registrationIds)
    .not('corporation_id', 'is', null)
    .returns<Array<{ corporation_id: number | string }>>()
  const corporationIds = uniq((regs ?? []).map((r) => Number(r.corporation_id)))
  if (corporationIds.length === 0) return null

  // A corporation whose name the directory hasn't backfilled yet can't be
  // addressed by slug, so it simply isn't listed rather than linking nowhere.
  const { data: corps } = await service
    .from('corporation')
    .select('corporation_id, name')
    .in('corporation_id', corporationIds)
    .not('name', 'is', null)
    .returns<Array<{ corporation_id: number | string; name: string }>>()
  const named = (corps ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
  if (named.length === 0) return null

  return (
    <>
      {named.map((corp) => (
        <p key={corp.corporation_id}>
          <Link href={`/bpos/${characterSlug(corp.name)}`}>{corp.name}&rsquo;s blueprint originals</Link> — everything
          in the corporation&rsquo;s hangars, shareable the same way.
        </p>
      ))}
    </>
  )
}

const BlueprintPage = () => (
  <>
    <h1>Blueprint</h1>
    <p>Given a blueprint, this tool will tell you which Upwell rigs give it a bonus.</p>
    <TypeSearch />
    <OwnBposLink />
    <CorpBposLinks />
  </>
)

export default BlueprintPage
