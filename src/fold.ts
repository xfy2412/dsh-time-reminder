/**
 * Durable per-Session state for the time reminder, derived by folding the Session log.
 *
 * The state is **not** written as a plugin-owned session event. DSH 0.2.0 has no
 * public API that marks an event `ignorable`, and the persistence read path
 * refuses to interpret a log containing an event type outside the harness
 * vocabulary unless the stored envelope carries that marker. A plugin-defined
 * type therefore makes the Session unreadable after a restart — the failure this
 * module exists to avoid.
 *
 * Everything the state needs already has a home in the log:
 *
 * - a successful `time_mode` / `time_counter` call: its `tool/call` arguments,
 *   applied once the matching `tool/result` reports success;
 * - the injected reading: a `user/message` whose `source.kind` is
 *   {@link PLUGIN_NAME}, which dates `lastInjectionAt`;
 * - `assistant/message` / `tool/result`: the newest model-visible message, the
 *   baseline of a turn's first step;
 * - `turn/start` / `turn/end`: the open-turn boundaries.
 *
 * This module is pure and zod-free: it imports only `./cron.ts` and `./types.ts`,
 * so its tests run with no package dependencies at all. `./state.ts` carries the
 * zod schema the projection validates the folded state with.
 *
 * @module dsh-time-reminder/fold
 */

import { parseCron } from './cron.ts'
import { DEFAULT_COUNTER_SCOPE } from './types.ts'
import type { CounterNoticeKind, CounterRecord, CounterScope, PendingCall, TimeMode, TimeReminderState } from './types.ts'

export type { CounterRecord, CounterScope, TimeMode, TimeReminderState } from './types.ts'
export { DEFAULT_COUNTER_SCOPE } from './types.ts'

/**
 * Cordis plugin name, and the projection key / injected-message source.
 *
 * Matches the package name so diagnostics, the injected-message source, and the
 * loader row all agree on one string.
 */
export const PLUGIN_NAME = 'dsh-time-reminder'

/** Projection key owned by this plugin; stable across versions. */
export const PROJECTION_KEY = 'time-reminder'

/** Tool whose arguments carry a mode and schedule change. */
export const TIME_MODE_TOOL = 'time_mode'

/** Tool whose arguments carry a counter change. */
export const TIME_COUNTER_TOOL = 'time_counter'

/**
 * Source form this plugin stamps on its automatic readings.
 *
 * The form is part of the fold's contract: only a message carrying it dates
 * `lastInjectionAt`, so a notice pushed from a related Session (which carries
 * {@link PUSH_FORM}) can never be mistaken for this Session's own reading and
 * cannot disturb its cron or turn cadence.
 */
export const READING_FORM = 'notice'

/** Source form this plugin stamps on a counter notice delivered to a related Session. */
export const PUSH_FORM = 'relay'

/**
 * How many unpaired tool calls the fold keeps. A call always receives a result
 * before its turn ends, so this boundary only matters for a log that was cut
 * mid-turn.
 */
const PENDING_LIMIT = 32

/** State of an empty log. */
export function initialState(mode: TimeMode, cron: string): TimeReminderState {
  return {
    mode,
    cron,
    lastInjectionAt: null,
    lastTurnInjectionAt: null,
    lastMessageAt: null,
    counters: [],
    pending: [],
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

/** One tool call's arguments, as parsed from `tool/call`. */
export type ToolArgs = Readonly<Record<string, unknown>>

/** What a counter call changed; see {@link CounterNoticeKind}. */
export type { CounterNoticeKind } from './types.ts'

/** One change a counter call commits, plus the sentence describing it. */
export interface CounterChange {
  readonly state: TimeReminderState
  readonly note: string
  /**
   * What to tell the Sessions that can see this counter, when the call changed it.
   *
   * `previous` is the counter as it stood before the call, which the caller needs
   * whenever the change can move the set of Sessions that see it (a scope edit,
   * a removal, a restart that rewrites the scope flags).
   */
  readonly announced?: {
    readonly kind: CounterNoticeKind
    readonly counter: CounterRecord
    readonly previous?: CounterRecord
  }
}

/**
 * Apply one `time_mode` call to the state.
 *
 * The tool and the log fold share this function, so a restored Session reaches
 * exactly the state the live call produced.
 *
 * @param state - state before the call.
 * @param args - validated tool arguments.
 * @returns the state the call commits.
 * @throws TypeError when the mode or the cron expression is invalid.
 */
export function timeModeChange(state: TimeReminderState, args: ToolArgs): TimeReminderState {
  const mode = args.mode
  if (mode !== 'off' && mode !== 'cron' && mode !== 'turn' && mode !== 'fine') {
    throw new TypeError(`invalid time mode ${JSON.stringify(args.mode)}; expected off, cron, turn, or fine`)
  }
  const requested = typeof args.cron === 'string' && args.cron.length > 0 ? args.cron : undefined
  // Validate here rather than at the call site: the fold must reject exactly the
  // arguments the tool rejected, or the two would disagree after a restore.
  if (requested !== undefined) parseCron(requested)
  return { ...state, mode, cron: requested ?? state.cron }
}

/**
 * Apply one `time_counter` call to the state.
 *
 * @param state - state before the call.
 * @param args - validated tool arguments.
 * @param at - instant the call started, used as a new counter's baseline.
 * @returns the state the call commits, with the sentence describing it.
 * @throws TypeError when the action is unknown, a required name is missing, or a named counter does not exist.
 */
export function counterChange(state: TimeReminderState, args: ToolArgs, at: number): CounterChange {
  const action = String(args.action)
  const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
  if (action !== 'list' && name === undefined) {
    throw new TypeError(`${TIME_COUNTER_TOOL}: action "${action}" requires a counter name`)
  }
  const existing = name === undefined ? undefined : state.counters.find((counter) => counter.name === name)
  switch (action) {
    case 'start': {
      const next: CounterRecord = {
        name: name!,
        startedAt: at,
        ...typeof args.note === 'string' ? { note: args.note } : {},
        inject: args.inject === true,
        scope: scopeFromArgs(args, existing?.scope ?? DEFAULT_COUNTER_SCOPE),
      }
      return {
        state: withCounter(state, next),
        note: existing === undefined ? `Started counter "${name}".` : `Restarted counter "${name}".`,
        announced: {
          kind: existing === undefined ? 'created' : 'restarted',
          counter: next,
          ...existing === undefined ? {} : { previous: existing },
        },
      }
    }
    case 'reset': {
      requireCounter(existing, name)
      const next: CounterRecord = { ...existing, startedAt: at }
      return {
        state: withCounter(state, next),
        note: `Reset counter "${name}".`,
        announced: { kind: 'reset', counter: next, previous: existing },
      }
    }
    case 'lapse':
      return {
        state,
        note: existing === undefined
          ? `Counter "${name}" does not exist.`
          : 'Elapsed times are measured from each counter\'s baseline.',
      }
    case 'list':
      return { state, note: 'Elapsed times are measured from each counter\'s baseline.' }
    case 'note': {
      requireCounter(existing, name)
      const next: CounterRecord = { ...existing, note: String(args.note ?? '') }
      return {
        state: withCounter(state, next),
        note: `Relabelled counter "${name}".`,
        announced: { kind: 'relabelled', counter: next, previous: existing },
      }
    }
    case 'scope': {
      requireCounter(existing, name)
      const next: CounterRecord = {
        ...existing,
        inject: args.inject === undefined ? existing.inject : args.inject === true,
        scope: scopeFromArgs(args, existing.scope),
      }
      return {
        state: withCounter(state, next),
        note: `Updated visibility for counter "${name}".`,
        announced: { kind: 'visibility', counter: next, previous: existing },
      }
    }
    case 'remove':
      requireCounter(existing, name)
      return {
        state: withoutCounter(state, name!),
        note: `Removed counter "${name}".`,
        announced: { kind: 'removed', counter: existing },
      }
    default:
      throw new TypeError(`${TIME_COUNTER_TOOL}: unknown action ${JSON.stringify(action)}`)
  }
}

/** The slice of a Session event the fold reads; structural so the fold needs no DSH runtime. */
export interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/**
 * Fold one Session event into the state.
 *
 * Unknown events and events this plugin does not own return the state unchanged.
 * A tool call changes the state only once its own `tool/result` reports success,
 * so a rejected or failed call leaves no trace — the same outcome the live tool
 * produced. Invalid arguments are dropped rather than raised: the log is data,
 * and a fold that throws would make the Session unreadable.
 *
 * @param state - state before this event.
 * @param event - the event to fold.
 * @returns the state after this event.
 */
export function applySessionEvent(state: TimeReminderState, event: SessionEventLike): TimeReminderState {
  switch (event.type) {
    case 'tool/call':
      return foldToolCall(state, event)
    case 'tool/result':
      return foldToolResult(state, event)
    case 'user/message':
      return isPluginReading(event.data)
        ? { ...state, lastInjectionAt: event.time, lastTurnInjectionAt: event.time }
        : state
    case 'assistant/message':
      return state.lastMessageAt === event.time ? state : { ...state, lastMessageAt: event.time }
    case 'turn/start':
    case 'turn/end':
      return state.pending.length === 0 && state.lastTurnInjectionAt === null
        ? state
        : { ...state, lastTurnInjectionAt: null, pending: [] }
    default:
      return state
  }
}

/** Record one of this plugin's tool calls until its result decides whether it commits. */
function foldToolCall(state: TimeReminderState, event: SessionEventLike): TimeReminderState {
  const data = asRecord(event.data)
  const name = data?.name
  if (name !== TIME_MODE_TOOL && name !== TIME_COUNTER_TOOL) return state
  const callId = data?.callId
  if (typeof callId !== 'string') return state
  let args: unknown
  try {
    args = JSON.parse(String(data?.arguments ?? ''))
  } catch {
    return state
  }
  const record = asRecord(args)
  if (record === undefined) return state
  const pending = [...state.pending, { callId, tool: name, args: record, at: event.time }]
  return { ...state, pending: pending.slice(-PENDING_LIMIT) }
}

/** Commit a recorded call once its successful result arrives; drop it on failure. */
function foldToolResult(state: TimeReminderState, event: SessionEventLike): TimeReminderState {
  const data = asRecord(event.data)
  const message = asRecord(data?.message)
  const callId = message?.toolCallId
  const base = state.lastMessageAt === event.time ? state : { ...state, lastMessageAt: event.time }
  if (typeof callId !== 'string') return base
  const call = base.pending.find((candidate) => candidate.callId === callId)
  if (call === undefined) return base
  const cleared: TimeReminderState = { ...base, pending: base.pending.filter((candidate) => candidate.callId !== callId) }
  return message?.isError === true ? cleared : commitCall(cleared, call)
}

/** Apply one recorded call, dropping it when its arguments cannot commit. */
function commitCall(state: TimeReminderState, call: PendingCall): TimeReminderState {
  try {
    if (call.tool === TIME_MODE_TOOL) return timeModeChange(state, call.args)
    return counterChange(state, call.args, call.at).state
  } catch {
    // A call whose arguments cannot commit is a call that failed; the log keeps
    // no other trace of it, and the tool reported its own error to the model.
    return state
  }
}

/** Whether one event's data is this plugin's own automatic reading. */
function isPluginReading(data: unknown): boolean {
  const record = asRecord(data)
  const source = asRecord(record?.source)
  return source?.kind === PLUGIN_NAME && source?.form === READING_FORM
}

/** Narrow an unknown value to a plain object without casting. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Refuse a counter action whose named counter is absent. */
function requireCounter(existing: CounterRecord | undefined, name: string | undefined): asserts existing is CounterRecord {
  if (existing === undefined) throw new TypeError(`counter "${name}" does not exist`)
}

/** Merge scope arguments over the previous scope, validating the depth. */
function scopeFromArgs(args: ToolArgs, previous: CounterScope): CounterScope {
  const depth = args.depth === undefined ? previous.depth : args.depth
  if (!Number.isSafeInteger(depth) || (depth as number) < 0) {
    throw new TypeError(`time-reminder: depth must be a non-negative safe integer, got ${String(args.depth)}`)
  }
  return {
    toChildren: args.toChildren === undefined ? previous.toChildren : args.toChildren === true,
    toParents: args.toParents === undefined ? previous.toParents : args.toParents === true,
    depth: depth as number,
  }
}
