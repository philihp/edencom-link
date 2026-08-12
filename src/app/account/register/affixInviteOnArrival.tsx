'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/utils/supabase/client'

import { affixInvite } from './actions'

// Affixes ?invite=… to the arriving account as referral attribution, the
// moment there is an account to affix it to (docs/open-registration.md).
//
// Client-side because of the ordering: the page renders before the root
// layout's anonymous sign-in has finished, so the server had no session to
// attribute the code to. This waits for one — already present for a returning
// visitor, announced by onAuthStateChange for a first-time one — then calls the
// server action once. Nothing renders; the code stays in the form either way,
// and the register action tolerates a code already affixed to the caller.

let affixed = false

const AffixInviteOnArrival = ({ code }: { code: string }) => {
  const router = useRouter()

  useEffect(() => {
    if (!code || affixed) return undefined
    const supabase = createClient()

    const affix = async () => {
      if (affixed) return
      affixed = true
      const result = await affixInvite(code)
      // 'affixed' is the only outcome the page looks different for (the
      // referred-by line renders server-side); the rest are quiet no-ops.
      if (result === 'affixed') router.refresh()
      else if (result === 'no-session') affixed = false
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) void affix()
    })
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) void affix()
    })

    return () => subscription.subscription.unsubscribe()
  }, [code, router])

  return null
}

export default AffixInviteOnArrival
