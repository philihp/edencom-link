import { fromPairs, map } from 'ramda'

import type { ApiData } from 'flags'
import { createFlagsDiscoveryEndpoint } from 'flags/next'

import { KNOWN_FLAGS } from '@/flags'

// Discovery endpoint for Vercel's Flags Explorer / Experimentation dashboard
// (https://vercel.com/docs/flags/flags-explorer/reference). Vercel fetches
// this (authenticated against FLAGS_SECRET) to learn which flags the app
// actually uses, so the dashboard lists KNOWN_FLAGS instead of stale
// hand-entered ones. Metadata only — evaluation stays per-user in
// user_settings.flags via hasFlag(); the Flags Explorer can't override it.
export const GET = createFlagsDiscoveryEndpoint(async (): Promise<ApiData> => ({
  definitions: fromPairs(
    map(
      ({ flag, label }) => [
        flag,
        {
          description: label,
          origin: 'https://edencom.link/account/settings/chancellor',
          options: [
            { value: false, label: 'Off' },
            { value: true, label: 'On' },
          ],
        },
      ],
      KNOWN_FLAGS
    )
  ),
  hints: [
    {
      key: 'per-user',
      text: 'Flags are dark-launched per account in user_settings.flags; toggle them on /account/settings/chancellor, not here.',
    },
  ],
}))
