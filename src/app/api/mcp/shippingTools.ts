// MCP tool for freight quotes against the KumGo shipping service
// (https://kumgo.space). Like the appraisal tools this is one of the few
// tools that leaves the deployment (openWorldHint: true): quotes are computed
// by kumgo.space, and the request carries only route, volume, collateral, and
// the rush flag — nothing from the caller's account. It reads no DB at all,
// but still only runs for authenticated MCP callers (withMcpAuth fronts the
// whole server).
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { fetchShippingRoutes, requestShippingQuote } from '@/kumgo'

import { textResult } from './lib'
import { describeRoute, resolveShippingRoute } from './shippingQuery'

export const registerShippingTools = (server: McpServer): void => {
  server.registerTool(
    'shipping_quote',
    {
      title: 'Shipping quote',
      description:
        'Quote the freight cost of hauling cargo on one of the alliance shipping lanes (KumGo, kumgo.space) — e.g. Jita to C-J6MT. Answers "what would it cost to ship 350k m³ with 20b collateral to C-J6". Name the origin and destination systems (matched fuzzily against the active routes); call with neither to list the routes and their rates. Rush service costs a large flat fee — leave it off unless the user explicitly wants a rush order.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        origin: z.string().optional().describe('Origin system, e.g. "Jita" (substring match against the route list)'),
        destination: z.string().optional().describe('Destination system, e.g. "C-J6"'),
        route_id: z.number().int().optional().describe('Exact KumGo route id, instead of origin/destination names'),
        volume_m3: z.number().positive().optional().describe('Cargo volume in m³ (required for a quote)'),
        collateral_isk: z
          .number()
          .min(0)
          .optional()
          .describe('Collateral in ISK — the cargo value covered if the hauler loses it (default 0)'),
        rush: z
          .boolean()
          .optional()
          .describe('Priority rush service, for a hefty flat fee (default false — most orders should not rush)'),
      }),
    },
    async ({ origin, destination, route_id, volume_m3, collateral_isk, rush }) => {
      const listing = await fetchShippingRoutes()
      if (!listing.ok) return textResult(listing.message)
      const { routes, settings } = listing

      // No route named and no volume asked about → the caller wants the menu.
      if (route_id == null && !origin?.trim() && !destination?.trim() && volume_m3 == null) {
        return textResult({
          routes: routes.map(describeRoute),
          ...(settings.maxVolumeM3 != null && { max_volume_m3: settings.maxVolumeM3 }),
          ...(settings.minRewardIsk != null && { min_reward_isk: settings.minRewardIsk }),
          ...(settings.rushFeeIsk != null && { rush_fee_isk: settings.rushFeeIsk }),
          note: 'Call again with origin, destination, volume_m3, and collateral_isk for a quote.',
        })
      }

      const match = resolveShippingRoute(routes, { routeId: route_id, origin, destination })
      if (!match.ok) return textResult(match.message)
      if (volume_m3 == null) {
        return textResult(`Matched ${describeRoute(match.route)} — pass volume_m3 (and collateral_isk) for a quote.`)
      }

      const result = await requestShippingQuote(match.route.id, volume_m3, collateral_isk ?? 0, rush ?? false)
      if (!result.ok) return textResult(result.message)

      const { quote, route } = result
      return textResult({
        route: describeRoute(route),
        ...(route.destinationFullName != null && { deliver_to: route.destinationFullName }),
        volume_m3,
        collateral_isk: collateral_isk ?? 0,
        rush: rush ?? false,
        freight_isk: quote.freightIsk,
        ...(quote.rushFeeIsk > 0 && { rush_fee_isk: quote.rushFeeIsk }),
        total_isk: quote.totalIsk,
        contract_reward_isk: quote.rewardIsk,
        note: 'Set the courier contract reward to contract_reward_isk and the collateral to collateral_isk. Quote computed live by kumgo.space.',
      })
    }
  )
}
