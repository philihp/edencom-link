// Pure target resolution and shortfall arithmetic for the `restock` root field
// (docs/sharing-layer/08-restock-lens.md). No I/O imports, so
// test/graphqlRestock.test.ts can exercise it under the node test runner — the
// same split filters.ts makes for the argument shaping.
//
// A restock line answers "how much should I buy": you name item types and the
// quantity you want ON HAND, and each line reports what you actually hold plus
// two computed columns. Both are there deliberately — `delta` is signed, so it
// shows overstock as readily as shortfall, while `toBuy` is the shopping
// number and never goes negative.
//
// REFUSALS BEAT SILENTLY WRONG SUMS, the same stance filters.ts takes on an
// unmatched filter entry. A target naming nothing, or naming two types at
// once, is an error rather than a line summed over the wrong denominator; so
// is naming one type twice, since the two targets would disagree about a
// single sum.
import { countBy, reduce, uniq } from 'ramda'

import type { NamedRef } from './filters.ts'

// Re-exported because it IS this module's input contract: the candidate shape
// the resolver hands `resolveTargets` after the ranked SDE search.
export type { NamedRef }

// What a caller asks for: an item type (id or whole name) and the quantity
// they want on hand. Quantity is a GraphQL Int, hence a 32-bit ceiling — the
// SUMS can exceed that, which is why the output columns are strings.
export type RawTarget = { type: string; quantity: number }

// The same, once the name has become an SDE type id.
export type ResolvedTarget = { typeId: number; quantity: number }

export type TargetResolution = { ok: true; targets: ResolvedTarget[] } | { ok: false; message: string }

const refuse = (message: string): TargetResolution => ({ ok: false, message })

type TargetOutcome = { ok: true; target: ResolvedTarget } | { ok: false; message: string }

// A bare positive integer is a type id, anything else a name — the same split
// the exact-list filters make (filters.ts splitRefEntries).
const isId = (entry: string): boolean => /^\d+$/.test(entry)

const resolveOne = (raw: RawTarget, candidatesFor: (name: string) => readonly NamedRef[]): TargetOutcome => {
  const entry = (raw.type ?? '').trim()
  if (entry === '') return { ok: false, message: 'A target needs an item type.' }
  if (!Number.isInteger(raw.quantity) || raw.quantity <= 0) {
    return {
      ok: false,
      message: `The target for "${entry}" must be a whole number above zero, not ${raw.quantity}.`,
    }
  }
  if (isId(entry)) return { ok: true, target: { typeId: Number(entry), quantity: raw.quantity } }

  const wanted = entry.toLowerCase()
  const ids = uniq(
    candidatesFor(entry)
      .filter((c) => c.name.toLowerCase() === wanted)
      .map((c) => c.id)
  )
  if (ids.length === 0) return { ok: false, message: `No item type matched "${entry}".` }
  // Where the `types:` filter happily keeps every match, a target needs ONE
  // denominator: two types sharing a name can't share a buffer level.
  if (ids.length > 1) {
    return {
      ok: false,
      message: `"${entry}" matched ${ids.length} item types (${ids.join(', ')}) — name the one you mean by id.`,
    }
  }
  return { ok: true, target: { typeId: Number(ids[0]), quantity: raw.quantity } }
}

export const resolveTargets = (
  raw: readonly RawTarget[],
  candidatesFor: (name: string) => readonly NamedRef[]
): TargetResolution => {
  if (raw.length === 0) return refuse('A restock list needs at least one target.')

  const outcomes = raw.map((target) => resolveOne(target, candidatesFor))
  const failed = outcomes.find((o): o is Extract<TargetOutcome, { ok: false }> => !o.ok)
  if (failed !== undefined) return refuse(failed.message)

  const targets = outcomes.flatMap((o) => (o.ok ? [o.target] : []))
  const counts = countBy((t: ResolvedTarget) => String(t.typeId), targets)
  const duplicated = Object.keys(counts).filter((typeId) => counts[typeId] > 1)
  if (duplicated.length > 0) {
    return refuse(
      `Each item type takes one target, but ${duplicated.map((id) => `type ${id}`).join(', ')} appears more than once.`
    )
  }
  return { ok: true, targets }
}

// An asset stack, narrowed to the two columns the sum needs.
export type Stack = { type_id: number | string; quantity: number | null }

export type RestockLine = {
  typeId: number
  target: number
  onHand: number
  // onHand - target: negative when short, positive when overstocked.
  delta: number
  // max(0, target - onHand) — the shopping number.
  toBuy: number
}

export const restockLines = (
  targets: readonly ResolvedTarget[],
  stacks: readonly Stack[],
  onlyBelowTarget: boolean
): RestockLine[] => {
  // A stack with no quantity counts as one unit — the same `quantity ?? 1` the
  // asset resolver applies, since ESI omits it for singletons (a ship, a
  // fitted module). The Map accumulator is mutated rather than re-spread per
  // stack: the accepted exception, since spreading would make this O(n²).
  const onHandByType = reduce(
    (acc: Map<number, number>, stack: Stack) => {
      const typeId = Number(stack.type_id)
      return acc.set(typeId, (acc.get(typeId) ?? 0) + (stack.quantity ?? 1))
    },
    new Map<number, number>(),
    stacks
  )

  // Target order is the caller's order — a shopping list is authored in one.
  const lines = targets.map((t): RestockLine => {
    const onHand = onHandByType.get(t.typeId) ?? 0
    return {
      typeId: t.typeId,
      target: t.quantity,
      onHand,
      delta: onHand - t.quantity,
      toBuy: Math.max(0, t.quantity - onHand),
    }
  })
  return onlyBelowTarget ? lines.filter((l) => l.toBuy > 0) : lines
}
