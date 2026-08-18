import type { SupabaseClient } from '@supabase/supabase-js'

// Facility tax rates as fractions, matching the user_settings columns.
export type TaxRates = {
  own: number
  public: number
}

// The rates a brand new account starts on, and what every read falls back to
// when no user_settings row exists yet: 0.1% for your own structures (what a
// corp typically charges its members) against 1% for a public one.
export const DEFAULT_TAX_RATES: TaxRates = { own: 0.001, public: 0.01 }

// Percent is what the client shows and what players say out loud; the column
// stores a fraction. Both directions live here so the form and the page can't
// disagree about the factor.
export const toPercent = (rate: number) => rate * 100
export const fromPercent = (percent: number) => percent / 100

// Rendered with as many decimals as the rate actually needs, so 0.1% doesn't
// become "0.100%" and a hand-set 1.25% keeps its quarter.
export const formatRate = (rate: number) => `${Number((rate * 100).toFixed(3))}%`

// This account's declared rates. RLS pins user_settings to the caller, so the
// row needs no explicit user_id filter beyond the one maybeSingle wants.
export const fetchTaxRates = async (supabase: SupabaseClient, userId: string): Promise<TaxRates> => {
  const { data } = await supabase
    .from('user_settings')
    .select('industry_tax_rate_own, industry_tax_rate_public')
    .eq('user_id', userId)
    .maybeSingle()
  return {
    own: data?.industry_tax_rate_own == null ? DEFAULT_TAX_RATES.own : Number(data.industry_tax_rate_own),
    public: data?.industry_tax_rate_public == null ? DEFAULT_TAX_RATES.public : Number(data.industry_tax_rate_public),
  }
}
