/**
 * Counter visibility across a Session lineage.
 *
 * A counter is visible to its own Session, and then to related Sessions only when
 * the counter opts in: ancestry is walked through `header.parentSession` up to the
 * configured depth, and descendants are found by scanning `ctx.sessions.list()`.
 * Nearest relation wins on a name collision, so a Session's own counter always
 * shadows an inherited one.
 *
 * @module dsh-time-reminder/visibility
 */

import type { CounterRecord, TimeReminderState } from './types.ts'

/** Minimal Session facts this module needs, kept structural for testability. */
export interface SessionFacts {
  readonly id: string
  readonly parentSession: string | undefined
}

/** One counter resolved for the current Session, with where it came from. */
export interface ResolvedCounter {
  readonly counter: CounterRecord
  /** `own` for the current Session, otherwise the direction it was inherited from. */
  readonly origin: 'own' | 'ancestor' | 'descendant'
  /** How many lineage steps away the owning Session is. */
  readonly distance: number
}

/** The Session store subset used to resolve a lineage. */
export interface LineageSource {
  /** Every Session currently known to the host. */
  list(): readonly SessionFacts[]
}

/**
 * Resolve the counters visible to one Session.
 *
 * @param current - the Session reading its clock.
 * @param own - that Session's own state.
 * @param source - Session store used for ancestry and descent lookup.
 * @param stateOf - reads another Session's counters.
 * @returns visible counters, nearest first.
 */
export function visibleCounters(
  current: SessionFacts,
  own: TimeReminderState,
  source: LineageSource,
  stateOf: (sessionId: string) => TimeReminderState | undefined,
): ResolvedCounter[] {
  const byName = new Map<string, ResolvedCounter>()
  for (const counter of own.counters) {
    byName.set(counter.name, { counter, origin: 'own', distance: 0 })
  }

  // Ancestors: a counter is visible here only when it opted into `toParents`, and
  // only within its own `depth`.
  let cursor = current.parentSession
  let distance = 1
  const all = source.list()
  const byId = new Map(all.map((session) => [session.id, session]))
  while (cursor !== undefined && distance <= 64) {
    const ancestor = byId.get(cursor)
    const ancestorState = stateOf(cursor)
    if (ancestorState !== undefined) {
      for (const counter of ancestorState.counters) {
        if (!counter.scope.toParents) continue
        if (counter.scope.depth < distance) continue
        if (!byName.has(counter.name)) byName.set(counter.name, { counter, origin: 'ancestor', distance })
      }
    }
    if (ancestor === undefined) break
    cursor = ancestor.parentSession
    distance += 1
  }

  // Descendants: expose a counter downward when it opted into `toChildren`, within
  // its `depth`. Only Sessions in this Session's own subtree are considered.
  const descendants = descendantsOf(current.id, all)
  for (const descendant of descendants) {
    const descendantState = stateOf(descendant.id)
    if (descendantState === undefined) continue
    for (const counter of descendantState.counters) {
      if (!counter.scope.toChildren) continue
      if (counter.scope.depth < descendant.distance) continue
      if (!byName.has(counter.name)) byName.set(counter.name, { counter, origin: 'descendant', distance: descendant.distance })
    }
  }

  return [...byName.values()].sort((left, right) =>
    left.distance - right.distance || (left.counter.name < right.counter.name ? -1 : 1))
}

/** Find this Session's descendants, breadth-first, with their distance. */
function descendantsOf(rootId: string, all: readonly SessionFacts[]): { id: string; distance: number }[] {
  const found: { id: string; distance: number }[] = []
  let frontier = [rootId]
  const seen = new Set([rootId])
  for (let distance = 1; distance <= 64 && frontier.length > 0; distance += 1) {
    const next: string[] = []
    for (const session of all) {
      if (session.parentSession === undefined) continue
      if (!frontier.includes(session.parentSession)) continue
      if (seen.has(session.id)) continue
      seen.add(session.id)
      found.push({ id: session.id, distance })
      next.push(session.id)
    }
    frontier = next
  }
  return found
}
