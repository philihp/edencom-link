'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

// Approve/deny an OAuth 2.1 authorization request against Supabase Auth (the
// authorization server behind the MCP endpoint — see /api/mcp). Both return a
// redirect_url that carries the authorization code (or the denial error) back
// to the OAuth client, so the browser leaves the site either way.
export const approveAuthorization = async (formData: FormData) => {
  const authorizationId = `${formData.get('authorization_id')}`
  const supabase = await createClient()
  const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId)
  if (error || !data) {
    throw new Error(error?.message ?? 'Approving the authorization failed')
  }
  redirect(data.redirect_url)
}

export const denyAuthorization = async (formData: FormData) => {
  const authorizationId = `${formData.get('authorization_id')}`
  const supabase = await createClient()
  const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId)
  if (error || !data) {
    throw new Error(error?.message ?? 'Denying the authorization failed')
  }
  redirect(data.redirect_url)
}
