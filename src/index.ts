/**
 * dsh-time-reminder — an adjustable-precision clock for the model, plus
 * Session-scoped elapsed-time counters whose visibility can span a Session lineage.
 *
 * Two model-visible surfaces:
 *
 * - an automatic reading appended to eligible steps (`off` disables it, `cron`
 *   injects when a cron occurrence has been crossed, `fine` injects every step);
 * - `time_mode` and `time_counter` tools, which stay available in every mode.
 *
 * Per-Session state is committed as `time-reminder/state` events carrying the whole
 * state, so the projection is rebuilt by folding the log and both the mode and the
 * injection history survive a Session restore.
 *
 * @module dsh-time-reminder
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  canonicalTimeZone,
  cronDue,
  describeSchedule,
  formatDuration,
  formatTimestamp,
  renderReading,
  type TimeMode,
} from './reading.ts'
import { parseCron } from './cron.ts'
import {
  DEFAULT_COUNTER_SCOPE,
  initialState,
  stateFromEventData,
  timeReminderStateSchema,
  withCounter,
  withoutCounter,
} from './state.ts'
import { PLUGIN_NAME, STATE_EVENT_TYPE } from './state.ts'
import type { CounterRecord, CounterScope, TimeMode, TimeReminderState } from './types.ts'
import { visibleCounters, type SessionFacts } from './visibility.ts'

/** Default schedule: once a day at 00:00 in the display zone. */
const DEFAULT_CRON = '0 0 * * *'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** One committed revision of this plugin's per-Session state. */
    'time-reminder/state': {
      readonly mode: TimeMode
      readonly counters: readonly CounterRecord[]
      readonly lastInjectionAt: number | null
      readonly lastTurnInjectionAt: number | null
      readonly lastMessageAt: number | null
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'time-reminder': TimeReminderState
  }
}

/** Plugin configuration. */
export interface Config {
  /** Display zone when the request carries no browser zone. Defaults to the process zone. */
  timeZone?: string
  /** Schedule for `cron` mode. Defaults to `0 0 * * *` (daily 00:00). */
  cron?: string
  /** Mode a Session starts in. Defaults to `cron`. */
  defaultMode?: TimeMode
  /**
   * Minimum milliseconds between readings in `fine` mode.
   * `0` reads on every step, which is the point of the mode.
   */
  fineIntervalMs?: number
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  cron: z.string().default(DEFAULT_CRON),
  defaultMode: z.union(['off', 'cron', 'turn', 'fine'] as const).default('cron'),
  fineIntervalMs: z.number().step(1).min(0).default(0),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME

/** Services this plugin reads. */
export const inject = ['sessions', 'sessionProjections', 'tools']

/** Tool name controlling the time mode. */
export const TIME_MODE_TOOL = 'time_mode'
/** Tool name managing counters. */
export const TIME_COUNTER_TOOL = 'time_counter'

/** The Session surface this plugin uses. */
export interface SessionHandle {
  readonly header: { readonly id: string; readonly parentSession?: string }
  append(type: never, data: never): unknown
}

/** A message whose source may carry the browser zone. */
interface MessageLike {
  readonly source?: unknown
}

/**
 * Register the time reminder.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - schedule, display zone, and defaults.
 * @throws TypeError when the cron expression, time zone, or fine interval is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const fallbackTimeZone = resolveFallbackTimeZone(config.timeZone)
  const configuredCron = config.cron ?? DEFAULT_CRON
  const defaultExpression = parseCron(configuredCron)
  const defaultMode: TimeMode = config.defaultMode ?? 'cron'
  const fineIntervalMs = config.fineIntervalMs ?? 0
  if (!Number.isSafeInteger(fineIntervalMs) || fineIntervalMs < 0) {
    throw new TypeError(`time-reminder: fineIntervalMs must be a non-negative safe integer, got ${String(fineIntervalMs)}`)
  }
  /** Parse one Session's schedule, refusing a corrupt stored expression loudly. */
  const expressionOf = (state: TimeReminderState): CronExpression => {
    if (state.cron === configuredCron) return defaultExpression
    try {
      return parseCron(state.cron)
    } catch (error) {
      throw new TypeError(`time-reminder: session stores an invalid cron expression ${JSON.stringify(state.cron)}`, { cause: error })
    }
  }

  ctx.sessionProjections.register({
    key: 'time-reminder',
    stateVersion: 1,
    stateSchema: timeReminderStateSchema,
    init: () => initialState(defaultMode, configuredCron),
    apply: (state, event) => {
      const committed = stateFromEventData(event.type, event.data, configuredCron)
      if (committed !== undefined) return committed
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        return state.lastTurnInjectionAt === null ? state : { ...state, lastTurnInjectionAt: null }
      }
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        // Step 1's baseline is the newest model-visible message, which is what "time
        // since the previous turn stopped" means in practice.
        return state.lastMessageAt === event.time ? state : { ...state, lastMessageAt: event.time }
      }
      return state
    },
  })

  /** Read one Session's committed state. */
  const stateOf = (sessionId: string): TimeReminderState => {
    const session = ctx.sessions.get(sessionId as never)
    if (session === undefined) return initialState(defaultMode, configuredCron)
    return ctx.sessionProjections.stateOf(session, 'time-reminder') ?? initialState(defaultMode, configuredCron)
  }

  /** Commit a state revision; the projection folds it back in. */
  const commit = (session: SessionHandle, state: TimeReminderState): void => {
    session.append(STATE_EVENT_TYPE as never, {
      mode: state.mode,
      cron: state.cron,
      counters: state.counters,
      lastInjectionAt: state.lastInjectionAt,
      lastTurnInjectionAt: state.lastTurnInjectionAt,
      lastMessageAt: state.lastMessageAt,
    } as never)
  }

  const scratch: SessionFacts[] = []
  const lineageSource = {
    list: (): readonly SessionFacts[] => {
      scratch.length = 0
      for (const session of ctx.sessions.list()) {
        scratch.push({ id: session.header.id, parentSession: session.header.parentSession })
      }
      return scratch
    },
  }
  const stateOfId = (sessionId: string): TimeReminderState | undefined => {
    const session = ctx.sessions.get(sessionId as never)
    if (session === undefined) return undefined
    return ctx.sessionProjections.stateOf(session, 'time-reminder')
  }
  /** The zone readings are displayed in for the request under construction. */
  const displayZone = (messages: readonly MessageLike[]): string => {
    const zones = requestTimeZones(messages)
    return zones.length === 1 ? zones[0]! : fallbackTimeZone
  }

  // ── the reading ────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const session = agent.session as SessionHandle
    const state = stateOf(session.header.id)
    if (state.mode === 'off') return decision

    const now = Date.now()
    const zone = displayZone(decision.messages)
    const expression = expressionOf(state)
    // `turn` reads once per turn, at the first step — the step that follows the
    // user's message. `cron` and `fine` keep their own schedules.
    if (state.mode === 'turn' && step !== 1) return decision
    if (state.mode === 'cron' && !cronDue(expression, zone, state.lastInjectionAt ?? undefined, now)) {
      return decision
    }
    if (state.mode === 'fine' && step > 1 && fineIntervalMs > 0) {
      const previous = state.lastTurnInjectionAt
      if (previous !== null && now - previous < fineIntervalMs) return decision
    }

    const facts: SessionFacts = { id: session.header.id, parentSession: session.header.parentSession }
    const counters = visibleCounters(facts, state, lineageSource, stateOfId)
      .filter((resolved) => resolved.counter.inject)
      .map((resolved) => ({
        name: resolved.counter.name,
        elapsedMs: now - resolved.counter.startedAt,
        ...resolved.counter.note === undefined ? {} : { note: resolved.counter.note },
      }))

    const text = renderReading({
      now,
      turn,
      step,
      mode: state.mode,
      zone,
      cron: expression,
      fresh: step === 1,
      // `turn` reads only at step 1 and always reports the gap to the previous turn;
      // `cron`/`fine` distinguish the first step from later ones.
      ...state.mode === 'turn'
        ? state.lastMessageAt === null ? {} : { sinceLastMessageMs: now - state.lastMessageAt }
        : step === 1
          ? state.lastMessageAt === null ? {} : { sinceMessageMs: now - state.lastMessageAt }
          : state.lastTurnInjectionAt === null ? {} : { sinceReadingMs: now - state.lastTurnInjectionAt },
      ...state.lastInjectionAt === null ? {} : { lastInjectionAt: state.lastInjectionAt },
      counters,
    })

    // The record of this injection is durable state, not process memory: `cron`
    // due-ness and the step deltas must survive a Session restore.
    commit(session, { ...state, lastInjectionAt: now, lastTurnInjectionAt: now })

    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: PLUGIN_NAME,
          form: 'snapshot',
          sections: [{ name: PLUGIN_NAME, text }],
        },
      })],
    }
  }, { prepend: true })

  // ── tools (available in every mode, including `off`) ───────────────────────
  ctx.tools.register(defineTool({
    name: TIME_MODE_TOOL,
    description: 'Set how often the current time is injected into your context in this session. off: never inject automatically, though you can still read the clock by calling this tool. cron: inject once whenever the configured schedule is crossed (default daily 00:00). turn: inject exactly once per turn, at the first step after the user message, which reports how long the previous turn has been over. fine: inject on every step, for precise timing and step durations.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['off', 'cron', 'turn', 'fine'],
        description: 'The precision to use from now on in this session.',
      },
      cron: {
        type: 'string',
        description: 'Cron expression for cron mode, interpreted in the session time zone. Defaults to the configured schedule.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          schedule: { type: 'string', required: true },
          timeZone: { type: 'string', required: true },
          now: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Time mode is now ${value.mode} (schedule ${value.schedule}, zone ${value.timeZone}).\nCurrent time: ${value.now}\n${value.note}`,
      }],
    },
    execute(args, exec) {
      const session = requireSession(exec)
      const state = stateOf(session.header.id)
      const mode = args.mode as TimeMode
      if (mode !== 'off' && mode !== 'cron' && mode !== 'turn' && mode !== 'fine') {
        throw new TypeError(`invalid time mode ${JSON.stringify(args.mode)}; expected off, cron, turn, or fine`)
      }
      const requested = typeof args.cron === 'string' && args.cron.length > 0 ? args.cron : undefined
      const activeText = requested ?? state.cron
      const active = requested === undefined ? expressionOf(state) : parseCron(requested)
      const zone = displayZone([])
      commit(session, { ...state, mode, cron: activeText })
      return {
        mode,
        schedule: describeSchedule(active, zone),
        timeZone: zone,
        now: formatTimestamp(Date.now(), zone),
        note: mode === 'off'
          ? 'Automatic readings are off. Call this tool whenever you need the current time.'
          : mode === 'cron'
            ? 'A reading is injected whenever the schedule is crossed, and at the first step of a turn after a gap.'
            : mode === 'turn'
              ? 'One reading per turn, at the first step, reporting how long the previous turn has been over.'
              : 'A reading accompanies every step, including after each tool call.',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TIME_COUNTER_TOOL,
    description: 'Create and read elapsed-time counters for this session, so long-running work can be timed across turns. Actions: start (create or restart), lapse (elapsed time), list, note (relabel), scope (visibility and injection), reset (restart the baseline), remove.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'lapse', 'list', 'note', 'scope', 'reset', 'remove'],
        description: 'What to do with the counter.',
      },
      name: {
        type: 'string',
        description: 'Counter name. Required for every action except list.',
      },
      note: {
        type: 'string',
        description: 'Label shown beside the elapsed time (start, note).',
      },
      inject: {
        type: 'boolean',
        description: 'Whether this counter joins every automatic reading (start, scope). Defaults to false when starting.',
      },
      toChildren: {
        type: 'boolean',
        description: 'Whether sessions delegated from this one may read it (scope). Defaults to true.',
      },
      toParents: {
        type: 'boolean',
        description: 'Whether this session\'s ancestors may read it (scope). Defaults to false.',
      },
      depth: {
        type: 'integer',
        description: 'How many lineage levels the exposure reaches (scope). Defaults to 1.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          now: { type: 'string', required: true },
          counters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                elapsed: { type: 'string', required: true },
                startedAt: { type: 'string', required: true },
                note: { type: 'string' },
                inject: { type: 'boolean', required: true },
                toChildren: { type: 'boolean', required: true },
                toParents: { type: 'boolean', required: true },
                depth: { type: 'integer', required: true },
                origin: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Current time: ${value.now}\n${value.counters.length === 0
          ? 'No counters are visible in this session.'
          : value.counters.map((counter) =>
            `- ${counter.name} = ${counter.elapsed}${counter.note === undefined ? '' : ` (${counter.note})`}`
            + `  [started ${counter.startedAt}; inject=${counter.inject};`
            + ` children=${counter.toChildren}; parents=${counter.toParents}; depth=${counter.depth}; origin=${counter.origin}]`).join('\n')}\n${value.note}`,
      }],
    },
    execute(args, exec) {
      const session = requireSession(exec)
      const state = stateOf(session.header.id)
      const now = Date.now()
      const zone = displayZone([])
      const action = String(args.action)
      const counterName = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
      let counters = state.counters
      let note = ''

      if (action !== 'list' && counterName === undefined) {
        throw new TypeError(`${TIME_COUNTER_TOOL}: action "${action}" requires a counter name`)
      }
      const existing = counterName === undefined ? undefined : state.counters.find((counter) => counter.name === counterName)

      switch (action) {
        case 'start':
          counters = withCounter(state, {
            name: counterName!,
            startedAt: now,
            ...typeof args.note === 'string' ? { note: args.note } : {},
            inject: args.inject === true,
            scope: scopeFromArgs(args, existing?.scope ?? DEFAULT_COUNTER_SCOPE),
          })
          note = existing === undefined ? `Started counter "${counterName}".` : `Restarted counter "${counterName}".`
          break
        case 'reset':
          if (existing === undefined) throw new TypeError(`counter "${counterName}" does not exist`)
          counters = withCounter(state, { ...existing, startedAt: now })
          note = `Reset counter "${counterName}".`
          break
        case 'lapse':
        case 'list':
          note = action === 'lapse' && existing === undefined
            ? `Counter "${counterName}" does not exist.`
            : 'Elapsed times are measured from each counter\'s baseline.'
          break
        case 'note':
          if (existing === undefined) throw new TypeError(`counter "${counterName}" does not exist`)
          counters = withCounter(state, { ...existing, note: String(args.note ?? '') })
          note = `Relabelled counter "${counterName}".`
          break
        case 'scope':
          if (existing === undefined) throw new TypeError(`counter "${counterName}" does not exist`)
          counters = withCounter(state, {
            ...existing,
            inject: args.inject === undefined ? existing.inject : args.inject === true,
            scope: scopeFromArgs(args, existing.scope),
          })
          note = `Updated visibility for counter "${counterName}".`
          break
        case 'remove':
          if (existing === undefined) throw new TypeError(`counter "${counterName}" does not exist`)
          counters = withoutCounter(state, counterName!)
          note = `Removed counter "${counterName}".`
          break
        default:
          assertNever(action as never, 'time counter action')
      }

      commit(session, { ...state, counters })
      const facts: SessionFacts = { id: session.header.id, parentSession: session.header.parentSession }
      const visible = visibleCounters(facts, { ...state, counters }, lineageSource, stateOfId)
      return {
        now: formatTimestamp(now, zone),
        counters: visible.map((resolved) => ({
          name: resolved.counter.name,
          elapsed: formatDuration(now - resolved.counter.startedAt),
          startedAt: formatTimestamp(resolved.counter.startedAt, zone),
          ...resolved.counter.note === undefined ? {} : { note: resolved.counter.note },
          inject: resolved.counter.inject,
          toChildren: resolved.counter.scope.toChildren,
          toParents: resolved.counter.scope.toParents,
          depth: resolved.counter.scope.depth,
          origin: resolved.origin,
        })),
        note,
      }
    },
  }))
}

/** The Session owning one tool call, or an error naming the missing contract. */
function requireSession(exec: { agent?: { session?: unknown } }): SessionHandle {
  const session = exec.agent?.session
  if (session === undefined || session === null) {
    throw new TypeError('time-reminder: this tool requires an agent session')
  }
  return session as SessionHandle
}

/** Resolve and validate the configured fallback zone, defaulting to the process zone. */
function resolveFallbackTimeZone(configured: string | undefined): string {
  if (configured === undefined) return new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
  try {
    return canonicalTimeZone(configured)
  } catch (error) {
    throw new TypeError(`time-reminder: invalid IANA timeZone ${JSON.stringify(configured)}`, { cause: error })
  }
}

/** Collect the browser zones carried by one request's user messages. */
export function requestTimeZones(messages: readonly MessageLike[]): string[] {
  const zones = new Set<string>()
  for (const message of messages) {
    const source = message.source
    if (source === null || typeof source !== 'object') continue
    const candidate = source as { kind?: unknown; clientTimeZone?: unknown }
    if (candidate.kind !== 'user' || typeof candidate.clientTimeZone !== 'string') continue
    zones.add(candidate.clientTimeZone)
  }
  return [...zones].sort()
}

/** Merge scope arguments over the previous scope, validating the depth. */
function scopeFromArgs(args: Record<string, unknown>, previous: CounterScope): CounterScope {
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
