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
 * Per-Session state (mode, schedule, counters, reading history) is **folded from
 * the Session log** rather than written as a plugin-owned event: DSH has no
 * public API that marks an event `ignorable`, and a log carrying an unknown
 * event type without that marker is refused on reload. See `./state.ts`.
 *
 * @module dsh-time-reminder
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import {
  canonicalTimeZone,
  counterNoticeText,
  cronDue,
  describeSchedule,
  formatDuration,
  formatTimestamp,
  readingSummary,
  renderReading,
  systemReminderBlock,
} from './reading.ts'
import { parseCron } from './cron.ts'
import {
  applySessionEvent,
  counterChange,
  initialState,
  timeModeChange,
  PLUGIN_NAME,
  PUSH_FORM,
  TIME_COUNTER_TOOL,
  TIME_MODE_TOOL,
} from './fold.ts'
import type { CounterChange } from './fold.ts'
import { timeReminderStateSchema } from './state.ts'
import type { TimeMode, TimeReminderState } from './types.ts'
import { pushTargets, visibleCounters, type SessionFacts } from './visibility.ts'

/** Default schedule: once a day at 00:00 in the display zone. */
const DEFAULT_CRON = '0 0 * * *'

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
  /**
   * How a counter notice reaches the related Sessions that can see the counter:
   * `inject` queues it for their next step without waking them (default),
   * `steer` also wakes an idle Session into a new turn, and `off` sends none.
   */
  counterNotice?: 'inject' | 'steer' | 'off'
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  cron: z.string().default(DEFAULT_CRON),
  defaultMode: z.union(['off', 'cron', 'turn', 'fine'] as const).default('cron'),
  fineIntervalMs: z.number().step(1).min(0).default(0),
  counterNotice: z.union(['inject', 'steer', 'off'] as const).default('inject'),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME

/** Services this plugin reads. */
export const inject = ['sessions', 'sessionProjections', 'tools', 'agents']

/** Tool names; the fold reads the same names back out of the log. */
export { TIME_COUNTER_TOOL, TIME_MODE_TOOL }

/** The Session surface this plugin uses. */
export interface SessionHandle {
  readonly header: { readonly id: string; readonly parentSession?: string }
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
  const counterNoticeMode = config.counterNotice ?? 'inject'
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
    // Bumped from 1 when the state stopped being committed as a plugin-owned
    // event and became a fold of the log: `pending` was added, and the
    // projection cache keys its rows by this version — a cached row written at
    // version 1 lacks the field, so it must not be adopted.
    stateVersion: 2,
    stateSchema: timeReminderStateSchema,
    init: () => initialState(defaultMode, configuredCron),
    // The whole state is a fold of events this plugin already produces: its own
    // tool calls (committed once their result reports success) and its own
    // injected readings. No plugin-owned event type, so no unknown type can
    // reach the log and make the Session unreadable on reload.
    apply: (state, event) => applySessionEvent(state, event),
  })

  /** Read one Session's committed state. */
  const stateOf = (sessionId: string): TimeReminderState => {
    const session = ctx.sessions.get(sessionId as never)
    if (session === undefined) return initialState(defaultMode, configuredCron)
    return ctx.sessionProjections.stateOf(session, 'time-reminder') ?? initialState(defaultMode, configuredCron)
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

  /**
   * Tell the Sessions a changed counter reaches — and, when the change can move
   * that set, the Sessions it just left.
   *
   * Delivery is the host's inbox seam: `inject` queues for the target's next step
   * without waking it, `steer` also wakes an idle target into a new turn. A target
   * whose Session is not resident is skipped; its state is still folded from the
   * log when it returns, so the counter reappears in its readings then.
   */
  const announceCounter = (owner: SessionHandle, announced: CounterChange['announced']): void => {
    if (announced === undefined || counterNoticeMode === 'off') return
    const facts: SessionFacts = { id: owner.header.id, parentSession: owner.header.parentSession }
    const text = systemReminderBlock(counterNoticeText(announced.kind, announced.counter, owner.header.id, displayZone([])))
    const targets = new Map<string, 'ancestor' | 'descendant'>()
    for (const target of pushTargets(facts, announced.counter, lineageSource)) targets.set(target.id, target.direction)
    if (announced.previous !== undefined) {
      for (const target of pushTargets(facts, announced.previous, lineageSource)) {
        if (!targets.has(target.id)) targets.set(target.id, target.direction)
      }
    }
    for (const id of targets.keys()) {
      const agent = ctx.agents.get(id as never)
      if (agent === undefined) continue
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // `relay` keeps the fold from reading this notice as a time reading; the
        // sender id is the durable record of who made the change.
        source: { kind: PLUGIN_NAME, form: PUSH_FORM, senderSessionId: owner.header.id },
      })
      if (counterNoticeMode === 'steer') agent.steer(message)
      else agent.inject(message)
    }
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
      // `turn` reads only at step 1 and always reports the gap to the previous turn.
      // `cron`/`fine` distinguish the first step from later ones; a later step with no
      // reading in this turn (`cron` firing mid-turn) falls back to the message
      // baseline rather than reporting nothing.
      ...state.mode === 'turn'
        ? state.lastMessageAt === null ? {} : { sinceLastMessageMs: now - state.lastMessageAt }
        : step === 1 || state.lastTurnInjectionAt === null
          ? state.lastMessageAt === null ? {} : { sinceMessageMs: now - state.lastMessageAt }
          : { sinceReadingMs: now - state.lastTurnInjectionAt },
      ...state.lastInjectionAt === null ? {} : { lastInjectionAt: state.lastInjectionAt },
      counters,
    })

    // The reading is its own durable record: the loop logs this message as a
    // `user/message` carrying `source.kind`, and the fold dates the next
    // `lastInjectionAt` from that event. Nothing else needs to be written.
    //
    // The framing and the `notice` form are presentation contracts: the body
    // reaches the model as system context instead of user speech, and the
    // collapsed context row shows the summary without expanding. A `snapshot`
    // form records no summary, which left the row showing only the producer
    // name — the reading was there but unreadable at a glance.
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: systemReminderBlock(text) }],
        source: {
          kind: PLUGIN_NAME,
          form: 'notice',
          summary: readingSummary(state.mode, now, zone),
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
      const now = Date.now()
      // The same pure change the log fold applies, so a restored Session lands on
      // exactly the state this call committed.
      const next = timeModeChange(stateOf(session.header.id), args)
      const mode = next.mode
      const zone = displayZone([])
      const active = expressionOf(next)
      return {
        mode,
        schedule: describeSchedule(active, zone),
        timeZone: zone,
        now: formatTimestamp(now, zone),
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
        description: 'How many lineage generations the exposure reaches (scope). Defaults to 2.',
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
      const now = Date.now()
      const zone = displayZone([])
      // The same pure change the log fold applies, so a restored Session lands on
      // exactly the state this call committed.
      const change = counterChange(stateOf(session.header.id), args, now)
      announceCounter(session, change.announced)
      const facts: SessionFacts = { id: session.header.id, parentSession: session.header.parentSession }
      const visible = visibleCounters(facts, change.state, lineageSource, stateOfId)
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
        note: change.note,
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
