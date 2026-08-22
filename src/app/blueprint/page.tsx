import Link from 'next/link'

import { createClient } from '@/utils/supabase/server'

import { characterSlug } from '../bpos/slug'
import { TypeSearch } from './typeSearch'

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

const BlueprintPage = () => (
  <>
    <h1>Blueprint</h1>
    <p>Given a blueprint, this tool will tell you which Upwell rigs give it a bonus.</p>
    <TypeSearch />
    <OwnBposLink />
  </>
)

export default BlueprintPage
