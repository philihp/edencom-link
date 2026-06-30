import { flag } from 'flags/next'

import { createClient } from '@/utils/supabase/server'

// Per-user gate for the /indexes page, backed by the 'indexes' entry in
// user_settings.flags (see schema.sql). Defaults to false for signed-out
// users and anyone without a row yet.
export const indexesFlag = flag<boolean>({
  key: 'indexes',
  description: 'Show the Indexes page and nav link',
  decide: async () => {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return false

    const { data } = await supabase.from('user_settings').select('flags').eq('user_id', user.id).maybeSingle()
    return (data?.flags ?? []).includes('indexes')
  },
})
