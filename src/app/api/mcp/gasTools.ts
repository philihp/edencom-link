// MCP tool gas_purchase_plan: split a purchase of reaction gas between the raw
// and the compressed form, from the depth of the Jita sell book.
//
// It reads two public tables only: the SDE mirror (gas names and volumes) and
// market_order_book (the Jita sell orders the hourly market-depth job writes).
// No player data, no ESI call, no third party, so it uses the public-read anon
// client. The arithmetic is the pure seam in ./gasDepth.ts.
import type { McpServer } from '@modelcontextprotocol/server'
import { groupBy, map, minBy, reduce, sum, uniq } from 'ramda'
import { z } from 'zod'

import { getSdeTypesInGroups } from '@/sdeTypes'
import { sdeSupabase } from '@/utils/supabase/sde'

import {
  COMPRESSED_GAS_GROUP_ID,
  COMPRESSED_YIELD,
  type Book,
  type GasType,
  HARVESTABLE_CLOUD_GROUP_ID,
  type Leg,
  matchGas,
  type Order,
  pairGases,
  planSplit,
  toLevels,
} from './gasDepth'
import { fetchAllRows, textResult, type ToolResult } from './lib'

const MARKET = 'jita'
const MAX_GASES = 40
// The job runs every hour. A book older than this is a sign the job failed.
const STALE_MS = 3 * 60 * 60 * 1000

type BookRow = Order & { type_id: number; captured_at: string }

const readBooks = (typeIds: number[]): Promise<BookRow[]> =>
  fetchAllRows<BookRow>((from, to) =>
    sdeSupabase()
      .from('market_order_book')
      .select('type_id, price, volume_remain, captured_at')
      .eq('market', MARKET)
      .in('type_id', typeIds)
      .order('type_id')
      .order('price')
      .order('order_id')
      .range(from, to)
  )

const isk = (n: number): number => Math.round(n * 100) / 100

const bookOf = (rowsByType: Record<string, BookRow[] | undefined>, type: GasType | null): Book => ({
  volumeM3: type?.volume ?? 0,
  levels: type
    ? toLevels(
        map((r) => ({ price: Number(r.price), volume_remain: Number(r.volume_remain) }), rowsByType[type.typeID] ?? [])
      )
    : [],
})

const legOut = (names: { raw: string; compressed: string | null }) => (leg: Leg) => ({
  buy: leg.form === 'raw' ? names.raw : names.compressed,
  units: leg.units,
  isk: isk(leg.isk),
  price_from: leg.fromPrice,
  price_to: leg.toPrice,
  landed_per_usable_from: isk(leg.fromLanded),
  landed_per_usable_to: isk(leg.toLanded),
})

export const registerGasTools = (server: McpServer): void => {
  server.registerTool(
    'gas_purchase_plan',
    {
      title: 'Gas purchase plan (market depth)',
      description:
        'Plan a purchase of Fullerite, Mykoserocin or Cytoserocin gas in Jita for use in C-J6MT, from the depth of the Jita sell book. A large purchase walks up the sell orders, so the price of each next unit rises; at some point the other form (raw or compressed) becomes cheaper per usable unit. For each gas this tool walks both books together, cheapest landed cost per usable unit first — (price + freight per m³ × m³ per unit), divided by 0.95 for compressed gas, which decompresses at 95% — and answers how many units of each form to buy, the legs where the plan changes form, the total cost with freight, and the C-J6 ceiling: the landed cost of the last usable unit, the most it is worth to pay in C-J6MT. quantity is usable units wanted in C-J6MT. Get freight_isk_per_m3 from shipping_quote first. The book is a snapshot from an hourly job (book_captured_at). Read get_skill "Buying gas for C-J6MT" for the whole procedure.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              gas: z
                .string()
                .min(1)
                .describe('The gas, raw or compressed name, e.g. "Fullerite-C50", "Amber Mykoserocin"'),
              quantity: z.number().int().positive().describe('Usable units wanted in C-J6MT, after decompression'),
            })
          )
          .min(1)
          .max(MAX_GASES),
        freight_isk_per_m3: z
          .number()
          .min(0)
          .describe(
            'Freight in ISK for each m³ hauled Jita → C-J6MT, from shipping_quote for the tier of the whole load. 0 if the whole load fits the free tier.'
          ),
      }),
    },
    async ({ items, freight_isk_per_m3 }): Promise<ToolResult> => {
      const types = await getSdeTypesInGroups([HARVESTABLE_CLOUD_GROUP_ID, COMPRESSED_GAS_GROUP_ID])
      if (types.length === 0)
        return textResult('The gas types are not in the SDE mirror. Try again after the mirror runs.')
      const pairs = pairGases(
        map((t) => ({ typeID: t.typeID, name: t.name, groupID: t.groupID, volume: t.volume }), types)
      )
      const matches = map((item) => ({ item, match: matchGas(pairs, item.gas) }), items)
      const misses = matches.flatMap(({ match }) => (match.ok ? [] : [match.message]))
      if (misses.length > 0) return textResult(misses.join(' '))

      const resolved = matches.flatMap(({ item, match }) =>
        match.ok ? [{ quantity: item.quantity, pair: match.pair }] : []
      )
      const typeIds = uniq(
        resolved.flatMap(({ pair }) => [pair.raw.typeID, ...(pair.compressed ? [pair.compressed.typeID] : [])])
      )
      const rows = await readBooks(typeIds)
      const rowsByType = groupBy((r: BookRow) => String(r.type_id), rows)

      const gases = map(({ quantity, pair }) => {
        const split = planSplit(
          quantity,
          freight_isk_per_m3,
          bookOf(rowsByType, pair.raw),
          bookOf(rowsByType, pair.compressed)
        )
        const names = { raw: pair.raw.name, compressed: pair.compressed?.name ?? null }
        return {
          gas: pair.raw.name,
          wanted_usable: quantity,
          usable_planned: split.usable,
          ...(split.short > 0 && {
            short: split.short,
            short_note:
              'The Jita sell book of both forms ends before this quantity. Buy the rest in C-J6MT or with a buy order.',
          }),
          ...(pair.compressed == null && { note: 'This gas has no compressed form in the SDE.' }),
          buy: [
            { name: names.raw, units: split.raw.units, isk: isk(split.raw.isk), volume_m3: split.raw.volumeM3 },
            ...(names.compressed
              ? [
                  {
                    name: names.compressed,
                    units: split.compressed.units,
                    isk: isk(split.compressed.isk),
                    volume_m3: split.compressed.volumeM3,
                  },
                ]
              : []),
          ].filter((b) => b.units > 0),
          legs: map(legOut(names), split.legs),
          freight_isk: isk(split.freightIsk),
          landed_isk: isk(split.landedIsk),
          average_landed_per_usable: split.averageLanded == null ? null : isk(split.averageLanded),
          cj6_ceiling_raw: split.marginalLanded == null ? null : isk(split.marginalLanded),
          cj6_ceiling_compressed: split.marginalLanded == null ? null : isk(split.marginalLanded * COMPRESSED_YIELD),
          jita_isk: isk(split.raw.isk + split.compressed.isk),
          volume_m3: split.raw.volumeM3 + split.compressed.volumeM3,
          multibuy: [
            ...(split.raw.units > 0 ? [`${names.raw} ${split.raw.units}`] : []),
            ...(split.compressed.units > 0 ? [`${names.compressed} ${split.compressed.units}`] : []),
          ],
        }
      }, resolved)

      const oldest =
        rows.length > 0
          ? reduce(
              minBy((s: string) => Date.parse(s)),
              rows[0].captured_at,
              map((r) => r.captured_at, rows)
            )
          : null
      const stale = oldest != null && Date.now() - Date.parse(oldest) > STALE_MS
      return textResult({
        market: 'Jita 4-4 sell orders',
        book_captured_at: oldest,
        ...(oldest == null && {
          book_note: 'No order book is stored for these gases. The market-depth job has not run yet.',
        }),
        ...(stale && { book_note: 'The order book is more than 3 hours old. The market-depth job can be failing.' }),
        freight_isk_per_m3,
        gases,
        haul: {
          volume_m3: sum(map((g) => g.volume_m3, gases)),
          jita_isk: isk(sum(map((g) => g.jita_isk, gases))),
          freight_isk: isk(sum(map((g) => g.freight_isk, gases))),
          note: 'Freight is billed per haul, by the tier of the whole load. If the haul volume moves it to another tier, call shipping_quote for that volume and run this tool again with that rate.',
        },
        multibuy: gases.flatMap((g) => g.multibuy).join('\n'),
      })
    }
  )
}
