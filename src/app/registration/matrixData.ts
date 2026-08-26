// The grant side of the /registration matrix: which ESI scopes each of the
// caller's characters has actually granted, and which ones the account's
// request template will ask for next time. The job side comes from
// fetchJobsOverview; matrix.ts fuses the two per cell.
//
// token.scope is readable only by the service role — the table's grants stop
// at service_role on purpose (a browser that can read its own refresh_token is
// an XSS-to-EVE-account bridge; see schema.sql). The scope ARRAY is not the
// secret, so this reads it the way /bpos and /corpses read their tables:
// service client, scoped to registration ids the caller's own RLS-limited
// session already proved it owns, selecting only the columns needed.
import type { SupabaseClient } from '@supabase/supabase-js'
import { forEach } from 'ramda'

import { createServiceClient } from '@/utils/supabase/service'

import { getEnabledScopes } from '../character/userScopes'

export type GrantOverview = {
  // Per registration uuid: the scopes its token actually carries. A
  // registration with no token row (or an empty grant) maps to an empty set.
  grantedByRegistration: Map<string, Set<string>>
  // The scopes the next SSO request will ask for — required plus whatever
  // optional ones the template has on (userScopes.ts).
  template: Set<string>
}

export const fetchGrantOverview = async (
  supabase: SupabaseClient,
  userId: string,
  registrationIds: readonly string[]
): Promise<GrantOverview> => {
  const template = new Set(await getEnabledScopes(supabase, userId))

  const grantedByRegistration = new Map<string, Set<string>>(registrationIds.map((id) => [id, new Set<string>()]))
  if (registrationIds.length > 0) {
    const { data } = await createServiceClient()
      .from('token')
      .select('registration_id, scope')
      .in('registration_id', [...registrationIds])
    forEach(
      (row) => grantedByRegistration.set(row.registration_id as string, new Set((row.scope ?? []) as string[])),
      data ?? []
    )
  }

  return { grantedByRegistration, template }
}
