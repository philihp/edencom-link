// MCP tool for freight quotes against the KumGo shipping service
// (https://kumgo.space). Like the appraisal tools this is one of the few
// tools that leaves the deployment (openWorldHint: true): quotes are computed
// by kumgo.space, and the request carries only route, volume, collateral, and
// the rush flag — nothing from the caller's account. A cargo manifest (when
// no collateral figure is given) additionally goes to innomin.at for
// valuation, item names and quantities only, same as appraise_items. It reads
// no DB at all, but still only runs for authenticated MCP callers
// (withMcpAuth fronts the whole server).
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { appraise, type Market } from '@/innominate'
import { fetchShippingRoutes, requestShippingQuote } from '@/kumgo'

import { resolveManifest, textResult } from './lib'
import {
  basisMarket,
  basisValue,
  COLLATERAL_BASES,
  DEFAULT_COLLATERAL_BASIS,
  describeRoute,
  resolveShippingRoute,
  type CollateralBasis,
} from './shippingQuery'

// The appraisal-backed collateral (and volume) for a manifest, or a message
// explaining why the cargo couldn't be valued. Collateral protects the whole
// load, so any unpriced line refuses the appraisal rather than silently
// under-collateralizing what did price.
type ManifestValuation =
  | {
      ok: true
      collateralIsk: number
      volumeM3: number
      echo: Record<string, unknown>
      notes: string[]
    }
  | { ok: false; message: string }

const valueManifest = async (
  items: Array<{ item: string; quantity?: number }>,
  basis: CollateralBasis
): Promise<ManifestValuation> => {
  const { lines, notes } = await resolveManifest(items)
  // save: false — the valuation must stay stateless on innomin.at's side;
  // no appraisal record is minted for a shipping quote.
  const result = await appraise(lines, basisMarket(basis) as Market, false)
  if (!result.ok) {
    if (result.kind === 'unconfigured')
      return { ok: false, message: "Appraisals aren't configured on this deployment (missing INNOMINATE_API_KEY)." }
    if (result.kind === 'rate_limited')
      return {
        ok: false,
        message: `The appraisal service is rate limited.${
          result.retryAfterSeconds != null ? ` Try again in ${result.retryAfterSeconds}s.` : ''
        }`,
      }
    return { ok: false, message: result.message }
  }

  const { appraisal } = result
  const unpriced = appraisal.items.filter((i) => i.error != null)
  if (unpriced.length > 0) {
    const detail = unpriced
      .map((i) => `"${i.name}"${i.possibleMatches.length ? ` (did you mean: ${i.possibleMatches.join(', ')}?)` : ''}`)
      .join('; ')
    return {
      ok: false,
      message: `Couldn't appraise the whole cargo, so no collateral was derived — unpriced: ${detail}. Fix the item names, or pass collateral_isk explicitly.`,
    }
  }

  return {
    ok: true,
    collateralIsk: basisValue(basis, appraisal),
    volumeM3: appraisal.totalVol,
    echo: {
      collateral_basis: basis,
      appraised_market: appraisal.market,
      appraised_sell: appraisal.totalSellValue,
      appraised_buy: appraisal.totalBuyValue,
      appraised_split: appraisal.priceSplit,
      appraised_volume_m3: appraisal.totalVol,
      appraisal_source: 'innomin.at',
      ...(appraisal.cached && { appraisal_cached: true }),
    },
    notes,
  }
}

export const registerShippingTools = (server: McpServer): void => {
  server.registerTool(
    'shipping_quote',
    {
      title: 'Shipping quote',
      description:
        'Quote the freight cost of hauling cargo on one of the alliance shipping lanes (KumGo, kumgo.space) — e.g. Jita to C-J6MT. Answers "what would it cost to ship 350k m³ with 20b collateral to C-J6" or "what would shipping 100 Rifters to C-J6 cost". Name the origin and destination systems (matched fuzzily against the active routes); call with neither to list the routes and their rates. Either pass volume_m3 and collateral_isk directly, or pass the cargo as items — the load is then appraised (innomin.at) and its Jita sell value (or another collateral_basis) becomes the collateral, with the appraised volume filling in volume_m3 if omitted. Rush service costs a large flat fee — leave it off unless the user explicitly wants a rush order.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        origin: z.string().optional().describe('Origin system, e.g. "Jita" (substring match against the route list)'),
        destination: z.string().optional().describe('Destination system, e.g. "C-J6"'),
        route_id: z.number().int().optional().describe('Exact KumGo route id, instead of origin/destination names'),
        volume_m3: z
          .number()
          .positive()
          .optional()
          .describe('Cargo volume in m³ (omit to derive it from the appraised items)'),
        collateral_isk: z
          .number()
          .min(0)
          .optional()
          .describe(
            'Collateral in ISK — the cargo value covered if the hauler loses it. Omit to derive it by appraising items (or 0 with neither).'
          ),
        items: z
          .array(
            z.object({
              item: z
                .string()
                .min(1)
                .describe('Item name, e.g. "Tritanium", "Rifter" (matched fuzzily against EVE types)'),
              quantity: z.number().int().min(1).optional().describe('How many (default 1)'),
            })
          )
          .min(1)
          .max(100)
          .optional()
          .describe(
            'The cargo manifest, appraised to derive collateral (and volume) when those are not given explicitly'
          ),
        collateral_basis: z
          .enum(COLLATERAL_BASES)
          .optional()
          .describe(
            'Which appraised price collateralizes the items (default jita_sell). jita_* prices in Jita, cj6mt_* in the C-J6MT player market; *_split is the buy/sell midpoint.'
          ),
        rush: z
          .boolean()
          .optional()
          .describe('Priority rush service, for a hefty flat fee (default false — most orders should not rush)'),
      }),
    },
    async ({ origin, destination, route_id, volume_m3, collateral_isk, items, collateral_basis, rush }) => {
      const listing = await fetchShippingRoutes()
      if (!listing.ok) return textResult(listing.message)
      const { routes, settings } = listing

      // Nothing asked about at all → the caller wants the menu.
      if (route_id == null && !origin?.trim() && !destination?.trim() && volume_m3 == null && !items?.length) {
        return textResult({
          routes: routes.map(describeRoute),
          ...(settings.maxVolumeM3 != null && { max_volume_m3: settings.maxVolumeM3 }),
          ...(settings.minRewardIsk != null && { min_reward_isk: settings.minRewardIsk }),
          ...(settings.rushFeeIsk != null && { rush_fee_isk: settings.rushFeeIsk }),
          note: 'Call again with origin, destination, and either volume_m3 + collateral_isk or an items manifest for a quote.',
        })
      }

      const match = resolveShippingRoute(routes, { routeId: route_id, origin, destination })
      if (!match.ok) return textResult(match.message)

      // Explicit figures always win; the appraisal only fills the gaps. So a
      // manifest with an explicit collateral_isk still lends its volume, and
      // an explicit volume_m3 (say, repackaged ships) overrides the appraised
      // one while the value still collateralizes.
      let collateral = collateral_isk
      let volume = volume_m3
      let appraised: Record<string, unknown> | undefined
      let notes: string[] = []
      if ((collateral == null || volume == null) && items?.length) {
        const valuation = await valueManifest(items, collateral_basis ?? DEFAULT_COLLATERAL_BASIS)
        if (!valuation.ok) return textResult(valuation.message)
        collateral = collateral ?? valuation.collateralIsk
        volume = volume ?? valuation.volumeM3
        appraised = valuation.echo
        notes = valuation.notes
      }

      if (volume == null || volume <= 0) {
        return textResult(
          `Matched ${describeRoute(match.route)} — pass volume_m3, or an items manifest to derive volume and collateral, for a quote.`
        )
      }

      const result = await requestShippingQuote(match.route.id, volume, collateral ?? 0, rush ?? false)
      if (!result.ok) return textResult(result.message)

      const { quote, route } = result
      return textResult({
        route: describeRoute(route),
        ...(route.destinationFullName != null && { deliver_to: route.destinationFullName }),
        volume_m3: volume,
        collateral_isk: collateral ?? 0,
        ...(appraised != null && appraised),
        rush: rush ?? false,
        freight_isk: quote.freightIsk,
        ...(quote.rushFeeIsk > 0 && { rush_fee_isk: quote.rushFeeIsk }),
        total_isk: quote.totalIsk,
        contract_reward_isk: quote.rewardIsk,
        ...(notes.length && { notes }),
        note: 'Set the courier contract reward to contract_reward_isk and the collateral to collateral_isk. Quote computed live by kumgo.space.',
      })
    }
  )
}
