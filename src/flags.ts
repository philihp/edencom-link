import { flag } from 'flags/next'

import { createClient } from '@/utils/supabase/server'

// Per-user gate for the dark-launched /mercenary-dens page, backed by the
// 'mercenary-dens' entry in user_settings.flags. Defaults to false for
// signed-out users and anyone without the flag set.
export const mercenaryDensFlag = flag<boolean>({
  key: 'mercenary-dens',
  description: 'Show the Mercenary Dens page and nav link',
  decide: async () => {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return false

    const { data } = await supabase.from('user_settings').select('flags').eq('user_id', user.id).maybeSingle()
    return (data?.flags ?? []).includes('mercenary-dens')
  },
})

// Per-user gate for the dark-launched /corpses page, backed by the 'corpses'
// entry in user_settings.flags. Defaults to false for signed-out users and
// anyone without the flag set.
export const corpsesFlag = flag<boolean>({
  key: 'corpses',
  description: 'Show the Corpses page and nav link',
  decide: async () => {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return false

    const { data } = await supabase.from('user_settings').select('flags').eq('user_id', user.id).maybeSingle()
    return (data?.flags ?? []).includes('corpses')
  },
})
