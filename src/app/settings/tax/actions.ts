'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

import { fromPercent } from './rates'

// A percent typed into the form. Blank, non-numeric, negative or past the
// client's own ceiling is refused rather than clamped: silently saving a
// different number than the one on screen would quietly move the figure the
// page derives from it.
const parsePercent = (raw: FormDataEntryValue | null, label: string): number | string => {
  const text = `${raw ?? ''}`.trim()
  if (text === '') return `Enter a ${label}.`
  const percent = Number(text)
  if (!Number.isFinite(percent)) return `${label} must be a number.`
  if (percent < 0 || percent > 100) return `${label} must be between 0% and 100%.`
  return percent
}

export const saveTaxRates = async (formData: FormData): Promise<{ ok?: string; error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { error: 'You are not signed in.' }

  const own = parsePercent(formData.get('own'), 'Alt tax rate')
  if (typeof own === 'string') return { error: own }
  const publicRate = parsePercent(formData.get('public'), 'Public tax rate')
  if (typeof publicRate === 'string') return { error: publicRate }

  const { error } = await supabase.from('user_settings').upsert(
    {
      user_id: user.id,
      industry_tax_rate_own: fromPercent(own),
      industry_tax_rate_public: fromPercent(publicRate),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (error) return { error: error.message }

  // The cost-avoidance figure on /structure is derived from these two numbers,
  // so it is stale the moment they change.
  revalidatePath('/settings/tax')
  revalidatePath('/structure')
  return { ok: 'Saved.' }
}
