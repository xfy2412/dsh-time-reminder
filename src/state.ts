/**
 * Durable per-Session state for the time reminder: the time mode and the counters.
 *
 * The state is carried by a dedicated session event (`time-reminder/state`) rather
 * than living only in the projection fold, because a projection must be
 * reconstructible by folding the log: state with no originating event would be
 * lost on replay and could not be audited afterwards.
 *
 * @module dsh-time-reminder/state
 */

import { z } from 'zod'
import type { CounterRecord, CounterScope, TimeMode, TimeReminderState } from './types.ts'

export type { CounterRecord, CounterScope, TimeMode, TimeReminderState } from './types.ts'
export { DEFAULT_COUNTER_SCOPE } from './types.ts'

/** Cordis plugin name, and the projection key / event type namespace. */
export const PLUGIN_NAME = 'time-reminder'

/** Custom session event carrying one committed state revision. */
export const STATE_EVENT_TYPE = 'time-reminder/state'

/** Zod schema for {@link TimeReminderState}; persisted state is validated with it. */
export const timeReminderStateSchema = z.object({
  mode: z.union([z.literal('off'), z.literal('cron'), z.literal('turn'), z.literal('fine')]),
  cron: z.string(),
  lastInjectionAt: z.number().nullable(),
  lastTurnInjectionAt: z.number().nullable(),
  lastMessageAt: z.number().nullable(),
  counters: z.array(z.object({
    name: z.string(),
    startedAt: z.number(),
    note: z.string().optional(),
    inject: z.boolean(),
    scope: z.object({
      toChildren: z.boolean(),
      toParents: z.boolean(),
      depth: z.number(),
    }),
  })),
})

/** State of an empty log. */
export function initialState(mode: TimeMode, cron: string): TimeReminderState {
  return {
    mode,
    cron,
    lastInjectionAt: null,
    lastTurnInjectionAt: null,
    lastMessageAt: null,
    counters: [],
  }
}

/** Replace one counter by name, or append it. Pure. */
export function withCounter(state: TimeReminderState, next: CounterRecord): TimeReminderState {
  const index = state.counters.findIndex((counter) => counter.name === next.name)
  const counters = index < 0
    ? [...state.counters, next]
    : state.counters.map((counter, at) => (at === index ? next : counter))
  return { ...state, counters }
}

/** Drop one counter by name. Pure; returns the same reference when absent. */
export function withoutCounter(state: TimeReminderState, name: string): TimeReminderState {
  const counters = state.counters.filter((counter) => counter.name !== name)
  return counters.length === state.counters.length ? state : { ...state, counters }
}

/** Shape of the JSON payload carried by {@link STATE_EVENT_TYPE}. */
export interface StateEventData {
  readonly mode: TimeMode
  readonly cron: string
  readonly counters: readonly CounterRecord[]
  readonly lastInjectionAt: number | null
  readonly lastTurnInjectionAt: number | null
  readonly lastMessageAt: number | null
}

/**
 * Rebuild the whole state from one committed event payload.
 *
 * A committed revision carries the complete state rather than a delta, so the fold
 * is a plain replacement and needs no other event to be interpretable.
 *
 * @param type - the committed event's type.
 * @param data - its payload.
 * @param fallbackCron - schedule to assume for revisions written before `cron` was stored.
 * @returns the state to adopt, or `undefined` when this is not a state event.
 */
export function stateFromEventData(type: string, data: unknown, fallbackCron: string): TimeReminderState | undefined {
  if (type !== STATE_EVENT_TYPE) return undefined
  if (data === null || typeof data !== 'object') return undefined
  const candidate = data as Partial<StateEventData>
  if (candidate.mode !== 'off' && candidate.mode !== 'cron' && candidate.mode !== 'turn' && candidate.mode !== 'fine') return undefined
  if (!Array.isArray(candidate.counters)) return undefined
  return {
    mode: candidate.mode,
    cron: typeof candidate.cron === 'string' && candidate.cron.length > 0 ? candidate.cron : fallbackCron,
    counters: candidate.counters as readonly CounterRecord[],
    lastInjectionAt: nullableNumber(candidate.lastInjectionAt),
    lastTurnInjectionAt: nullableNumber(candidate.lastTurnInjectionAt),
    lastMessageAt: nullableNumber(candidate.lastMessageAt),
  }
}

/** Accept a committed nullable timestamp, defaulting a malformed one to null. */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
