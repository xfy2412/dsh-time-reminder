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

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
// Load the projection package's declarations: the root carries the
// `ctx.sessionProjections` service, `/types` the state map this file augments.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
// Loads the `session/created` declaration: the event that tells this plugin a
// Session became live (created, or restored from its log) so it can arm that
// Session's countdowns at once instead of waiting for its first step.
import type {} from '@deepseek-ai/dsh-session'
import {
  canonicalTimeZone,
  countdownNoticeText,
  counterNoticeText,
  cronDue,
  describeSchedule,
  formatDuration,
  formatTimestamp,
  readingSummary,
  renderReading,
  systemReminderBlock,
} from './reading.ts'
import { parseCron, type CronExpression } from './cron.ts'
import { MAX_TIMER_DELAY_MS, LISTED_FIRED_LIMIT, describeRemaining, listedCountdowns } from './countdown.ts'
import {
  fileStore,
  removeRow,
  rowsForSession,
  upsertRow,
  type PendingRow,
  type PendingStore,
} from './pending.ts'
import {
  applySessionEvent,
  countdownChange,
  counterChange,
  initialState,
  timeModeChange,
  COUNTDOWN_SOURCE_FIELD,
  PLUGIN_NAME,
  PUSH_FORM,
  TIME_COUNTER_TOOL,
  TIME_COUNTDOWN_TOOL,
  TIME_MODE_TOOL,
} from './fold.ts'
import type { CounterChange } from './fold.ts'
import { timeReminderStateSchema } from './state.ts'
import type { CountdownOnFire, CountdownRecord, TimeMode, TimeReminderState } from './types.ts'
import { pushTargets, visibleCounters, type SessionFacts } from './visibility.ts'

/** Default schedule: once a day at 00:00 in the display zone. */
const DEFAULT_CRON = '0 0 * * *'

/** How often the timer sweep re-reads resident Sessions, in milliseconds. */
const SWEEP_INTERVAL_MS = 60_000

/** How many pending countdowns one reading lists; the nearest ones win. */
const COUNTDOWN_LINE_LIMIT = 5

/**
 * Source fields of this plugin's injected context.
 *
 * `kind` answers who produced the message and `form` what it is: a reading is a
 * `notice` (it records the collapsed-row summary), and a counter notice pushed
 * from a related Session is a `relay` (it records the sender instead).
 */
interface TimeReminderMessageSource {
  readonly kind: 'dsh-time-reminder'
  /** Session that made the change a `relay` reports. */
  readonly senderSessionId?: string
  /**
   * Name of the countdown this message is the fire notice of.
   *
   * Its presence makes the message *not* a reading: the fold marks that countdown
   * fired instead of dating the injection baselines, so a firing countdown cannot
   * disturb the cron or turn cadence.
   */
  readonly countdown?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-time-reminder': TimeReminderMessageSource & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
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
  /**
   * Whether to keep the durable pending-countdown table. Defaults to `true`.
   *
   * The table is what lets a restarted host find countdowns whose Session nobody
   * restored; without it those reminders wait for the Session to come back.
   */
  pendingTable?: boolean
  /**
   * Path of the pending-countdown table.
   * Defaults to `<DSH_HOME>/time-reminder/countdowns.json`.
   */
  pendingPath?: string
  /**
   * Whether to append one JSON line per countdown lifecycle decision to
   * `<DSH_HOME>/time-reminder/debug.log`.
   *
   * The Host's logger keeps an in-memory ring buffer only, so a plugin whose
   * decisions must survive the process has to write them itself. Off by default:
   * turn it on when a cold-start or delivery question needs answering, which is how
   * the four defects around the pending table and the resume path were found.
   */
  debugLog?: boolean
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  cron: z.string().default(DEFAULT_CRON),
  defaultMode: z.union(['off', 'cron', 'turn', 'fine'] as const).default('cron'),
  fineIntervalMs: z.number().step(1).min(0).default(0),
  counterNotice: z.union(['inject', 'steer', 'off'] as const).default('inject'),
  pendingTable: z.boolean().default(true),
  pendingPath: z.string(),
  debugLog: z.boolean().default(false),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME

/** Services this plugin reads. */
export const inject = ['sessions', 'sessionProjections', 'tools', 'agents']

/** Tool names; the fold reads the same names back out of the log. */
export { TIME_COUNTER_TOOL, TIME_COUNTDOWN_TOOL, TIME_MODE_TOOL }

/** The Session surface this plugin uses. */
export interface SessionHandle {
  readonly header: { readonly id: string; readonly parentSession?: string }
}

/**
 * The part of the Host Web Session controller this plugin uses, read optionally.
 *
 * `resolveAgent` is documented as "resolve **or resume** one ordinary Session for
 * another Host API domain", which is what lets a countdown outlive a host restart
 * that restored no Session yet. Only a web-profile composition mounts it, so the
 * lookup goes through `ctx.get` and every caller tolerates `undefined`.
 */
interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<unknown>
}

/** The `<DSH_HOME>` path helper the Host provides, read optionally for the same reason. */
interface DshHomePathLike {
  (...segments: string[]): string
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
  /** `<DSH_HOME>` helper, when this composition provides one. */
  const homePath = ctx.get('dshHomePath') as DshHomePathLike | undefined
  /**
   * TEMPORARY (debug): append one JSON line per countdown lifecycle decision.
   *
   * Nothing else can witness these decisions: the Host's logger keeps an in-memory
   * ring buffer, and the Session log records only their effects. Every write is
   * fire-and-forget and swallows its own error, so debugging can never break or slow
   * delivery. Lines pass through one chained promise because independent appends
   * finish out of order — that made same-millisecond lines appear in a sequence their
   * timestamps contradicted, which cost a round of misreading.
   */
  const debugPath = config.debugLog === true ? homePath?.('time-reminder', 'debug.log') : undefined
  let debugWrite: Promise<void> = Promise.resolve()
  const debug = (event: string, details: Record<string, unknown> = {}): void => {
    if (debugPath === undefined) return
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`
    debugWrite = debugWrite
      .then(() => mkdir(dirname(debugPath), { recursive: true }))
      .then(() => appendFile(debugPath, line, 'utf8'))
      .catch(() => undefined)
  }
  /**
   * The durable pending table, or `undefined` when it is disabled or this
   * composition exposes no way to resolve `<DSH_HOME>`.
   *
   * It is an index, never a source of truth: a row only says "look at this
   * Session", and the folded log decides what is still pending.
   */
  const pendingStore: PendingStore | undefined = resolvePendingStore(homePath, ctx, config)
  debug('plugin.loaded', { debugPath, pendingTable: pendingStore !== undefined, mode: defaultMode, cron: configuredCron })
  /** In-memory mirror of the table; every write goes through `persistRows`. */
  let pendingRows: readonly PendingRow[] = []
  /** Serializes table writes so two quick commits cannot interleave. */
  let pendingWrite: Promise<void> = Promise.resolve()

  /**
   * Replace the stored table with `rows`, without letting a write failure break
   * reminder delivery: the table is an optimization for the next start.
   */
  const persistRows = (rows: readonly PendingRow[]): void => {
    pendingRows = rows
    debug('table.write', { rows: rows.length, stored: pendingStore !== undefined })
    if (pendingStore === undefined) return
    pendingWrite = pendingWrite
      .then(() => pendingStore.write(rows))
      .catch((error: unknown) => {
        ctx.logger.warn(`time-reminder: could not write the pending countdown table: ${String(error)}`)
      })
  }

  /**
   * Rewrite one Session's rows from the state that committed.
   *
   * Called where a countdown is created, moved, cancelled, or delivered, so the
   * table holds exactly the Sessions that still owe a reminder.
   */
  const syncRows = (sessionId: string, state: TimeReminderState): void => {
    if (pendingStore === undefined) return
    persistRows([...pendingRows.filter((row) => row.sessionId !== sessionId), ...rowsOf(sessionId, state)])
  }

  /**
   * Rebuild every live Session's rows from the folded log, leaving rows of Sessions
   * that are not live alone.
   *
   * This is what makes the table self-healing rather than write-only: it repairs a
   * table lost or hand-edited between runs, and it seeds rows for countdowns that
   * were committed before this plugin version started writing the table at all.
   *
   * It must run **after** the stored table has been read into `pendingRows`: it starts
   * from those rows and rewrites only the ones a live Session owns. Starting from an
   * empty in-memory mirror instead deletes every row whose Session is not live — the
   * exact rows a cold start depends on. (Measured 2026-10-11: that bug wiped the table
   * 360ms before the resume-retry reconcile read it, so the retry found nothing to do.)
   */
  const seedRows = (): void => {
    if (pendingStore === undefined) return
    let rows = pendingRows
    for (const session of ctx.sessions.list()) {
      const state = stateOfId(session.header.id)
      if (state === undefined) continue
      rows = [...rows.filter((row) => row.sessionId !== session.header.id), ...rowsOf(session.header.id, state)]
    }
    persistRows(rows)
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
    // Bumped from 1 when the state stopped being committed as a plugin-owned
    // event and became a fold of the log: `pending` was added, and the
    // projection cache keys its rows by this version — a cached row written at
    // version 1 lacks the field, so it must not be adopted. Bumped to 3 when
    // countdowns joined the state, for the same reason.
    stateVersion: 3,
    stateSchema: timeReminderStateSchema,
    init: () => initialState(defaultMode, configuredCron),
    // The whole state is a fold of events this plugin already produces: its own
    // tool calls (committed once their result reports success) and its own
    // injected readings. No plugin-owned event type, so no unknown type can
    // reach the log and make the Session unreadable on reload.
    //
    // The zone is a fold input, not ambient state: a countdown's `at` argument
    // must resolve to the same instant here as it did in the live tool.
    apply: (state, event) => applySessionEvent(state, event, fallbackTimeZone),
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
    // Keep the countdown timers of this Session honest on every step, whatever
    // happened to the projection in between.
    syncTimers(session.header.id, state)
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
    // Pending countdowns ride along so the model plans around what it scheduled
    // itself, rather than being surprised by its own reminder.
    const countdowns = state.countdowns
      .filter((record) => record.firedAt === undefined)
      .slice()
      .sort((left, right) => left.firesAt - right.firesAt)
      .slice(0, COUNTDOWN_LINE_LIMIT)
      .map((record) => ({
        name: record.name,
        inMs: record.firesAt - now,
        ...record.note === undefined ? {} : { note: record.note },
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
      ...countdowns.length === 0 ? {} : { countdowns },
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

  // ── countdown timers ───────────────────────────────────────────────────────
  /**
   * Armed timers, keyed by Session and countdown name.
   *
   * The host owns no store for these. A countdown lives in the Session log (as
   * the `time_countdown` call that set it) and every timer here is a
   * convenience rebuilt from that folded state: on plugin load, whenever the
   * owning Session takes a step, and by a slow sweep that catches whatever those
   * two paths cannot see yet.
   */
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; firesAt: number }>()
  /** Deliveries this process already made, so a notice still in flight cannot fire twice. */
  const delivered = new Set<string>()
  /** Sessions this process asked the Host to resolve or resume. */
  const resumeRequested = new Set<string>()
  const timerKey = (sessionId: string, name: string): string => `${sessionId}\u0000${name}`
  const deliveryKey = (sessionId: string, record: CountdownRecord): string => `${timerKey(sessionId, record.name)}\u0000${record.firesAt}`

  /** Drop one armed timer. */
  const forget = (key: string): void => {
    const armed = timers.get(key)
    if (armed === undefined) return
    clearTimeout(armed.timer)
    timers.delete(key)
  }

  /**
   * Deliver one fired countdown into the Session that set it.
   *
   * `wake` steers, which starts a turn on an idle Session — the point of a
   * countdown that promises an action. `inject` queues the same notice for the
   * next step and deliberately leaves the Session asleep.
   *
   * The notice names the actual reason it is not perfectly on time, observed
   * here rather than guessed: whether the timer was armed only after its instant
   * (nothing was running), how late the callback itself is, and whether the Agent
   * is mid-turn — in which case the notice necessarily waits for a step boundary.
   *
   * A Session that is not live is **resumed** rather than skipped: the Host Web
   * Session controller's `resolveAgent` resolves or resumes an ordinary Session for
   * another Host API domain, which is how a countdown survives a host restart that
   * restored nothing yet. The controller is read through `ctx.get` because it is an
   * optional service — a headless or SDK-only composition has none, and there the
   * notice can only be delivered once something else makes the Session live.
   *
   * @returns whether the notice reached the Session's inbox.
   */
  const deliverCountdown = async (sessionId: string, record: CountdownRecord, lateMs: number, caughtUp: boolean): Promise<boolean> => {
    let agent = ctx.agents.get(sessionId as never)
    /**
     * Whether *this plugin's* resume request is what made the Session deliverable.
     *
     * Two shapes reach that state, and both belong in the notice: the resume happens
     * inside this delivery (the branch below), or the table reconcile already asked
     * for it moments earlier, so the Agent is live by the time the timer fires. The
     * second shape is the common one — a cold start resumes at controller-available,
     * then arms — and reporting it as "not us" would misattribute the wake to the
     * client's reconnect.
     */
    let resumedHere = resumeRequested.has(sessionId)
    debug('deliver.begin', { sessionId, name: record.name, agentFound: agent !== undefined })
    if (agent === undefined) {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined) return false
      try {
        await controller.resolveAgent(sessionId)
        resumedHere = true
      } catch {
        // A resume that fails leaves the countdown pending; the next sweep retries.
        return false
      }
      // The registry owns the Agent once the Session is live; never hold the one
      // the controller returned, so `status` and delivery stay the registry's.
      agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) return false
    }
    const zone = displayZone([])
    const cause = { lateMs, caughtUp, sessionBusy: agent.status === 'running', resumedHere }
    const message = createUserMessage({
      content: [{ type: 'text', text: systemReminderBlock(countdownNoticeText(record.name, record.note, record.firesAt, zone, cause)) }],
      source: {
        kind: PLUGIN_NAME,
        form: 'notice',
        summary: `countdown "${record.name}" · ${formatTimestamp(record.firesAt, zone)}`,
        // The marker keeps this notice out of the reading path and tells the fold
        // that this countdown has fired, so a restart cannot repeat it.
        [COUNTDOWN_SOURCE_FIELD]: record.name,
      },
    })
    if (record.onFire === 'wake') agent.steer(message)
    else agent.inject(message)
    debug('deliver.done', { sessionId, name: record.name, lateMs, caughtUp, resumedHere, onFire: record.onFire })
    return true
  }

  /** Arm one countdown, firing at once when its instant has already passed. */
  const arm = (sessionId: string, record: CountdownRecord): void => {
    const key = timerKey(sessionId, record.name)
    const armed = timers.get(key)
    if (armed !== undefined) {
      if (armed.firesAt === record.firesAt) return
      forget(key)
    }
    if (delivered.has(deliveryKey(sessionId, record))) return
    const now = Date.now()
    const delay = record.firesAt - now
    // Armed after its instant: nothing was running at that moment to fire it, and
    // the notice will say so rather than blame timer jitter.
    const caughtUp = delay <= 0
    debug('arm', { sessionId, name: record.name, delayMs: delay, caughtUp })
    if (delay > MAX_TIMER_DELAY_MS) {
      // Farther out than a single timer can express: re-check once the window shortens.
      const timer = setTimeout(() => {
        timers.delete(key)
        syncSession(sessionId)
      }, MAX_TIMER_DELAY_MS)
      timer.unref()
      timers.set(key, { timer, firesAt: record.firesAt })
      return
    }
    const timer = setTimeout(() => {
      timers.delete(key)
      // Re-read the folded state: this countdown may have been cancelled or
      // snoozed while the timer was waiting.
      const current = stateOfId(sessionId)?.countdowns.find((candidate) => candidate.name === record.name)
      if (current === undefined || current.firedAt !== undefined || current.firesAt !== record.firesAt) {
        debug('fire.skipped', {
          sessionId,
          name: record.name,
          gone: current === undefined,
          alreadyFired: current?.firedAt !== undefined,
        })
        return
      }
      const delivery = deliveryKey(sessionId, current)
      const lateMs = Math.max(0, Date.now() - current.firesAt)
      debug('fire', { sessionId, name: current.name, lateMs, caughtUp })
      void deliverCountdown(sessionId, current, lateMs, caughtUp).then((sent) => {
        // Bookkeeping only after the notice really reached an inbox: a delivery
        // that could not happen (no Agent yet, failed resume) stays pending, so
        // the next sync retries it instead of silently dropping the reminder.
        debug('fire.settled', { sessionId, name: current.name, delivered: sent })
        if (!sent) return
        delivered.add(delivery)
        // A delivered countdown leaves the table at once: the table exists to be
        // read after a restart, and this reminder is no longer owed.
        persistRows(removeRow(pendingRows, sessionId, current.name))
      })
    }, Math.max(0, delay))
    timer.unref()
    timers.set(key, { timer, firesAt: record.firesAt })
  }

  /**
   * Bring one Session's armed timers in line with the countdowns a state holds.
   *
   * It only ever *adds* timers. Absence of a countdown in one state is not evidence
   * that it was cancelled: the projection can lag the `tool/result` that committed
   * it, so a sync racing a fresh commit would cancel a live timer and lose up to a
   * whole sweep interval. The timer callback re-reads the state and skips a
   * countdown that really is gone or already fired, which makes that check the one
   * authority on removal — a cancelled countdown merely leaves a timer that fires
   * once and does nothing.
   */
  const syncTimers = (sessionId: string, state: TimeReminderState): void => {
    for (const record of state.countdowns) {
      if (record.firedAt !== undefined) continue
      arm(sessionId, record)
    }
  }

  /** Re-read one Session's committed state and sync its timers. */
  const syncSession = (sessionId: string): void => {
    const state = stateOfId(sessionId)
    if (state !== undefined) syncTimers(sessionId, state)
  }

  ctx.effect(() => {
    /**
     * Resolve what the durable table says is still owed.
     *
     * This is the path that no other arming path can replace: after a restart the
     * plugin cannot *discover* a countdown whose Session nobody restored — the
     * Session registry lists live Sessions only. The table names those Sessions, and
     * `resolveAgent` resumes them, after which the folded log decides whether the
     * reminder is still pending (a row whose countdown vanished or already fired is
     * dropped here). Rows it cannot act on stay put for the next attempt.
     */
    const reconcileTable = async (): Promise<void> => {
      if (pendingStore === undefined) return
      let rows: readonly PendingRow[]
      try {
        rows = await pendingStore.read()
      } catch (error: unknown) {
        ctx.logger.warn(`time-reminder: could not read the pending countdown table: ${String(error)}`)
        return
      }
      pendingRows = rows
      debug('reconcile.start', { rows: rows.length })
      for (const row of rows) {
        const state = stateOfId(row.sessionId)
        if (state === undefined) {
          // No live Session under that id: ask the Host to resolve or resume it.
          const controller = ctx.get('sessionController') as SessionControllerLike | undefined
          if (controller === undefined) {
            debug('reconcile.row', { sessionId: row.sessionId, name: row.name, live: false, verdict: 'no-controller' })
            continue
          }
          debug('reconcile.row', { sessionId: row.sessionId, name: row.name, live: false, verdict: 'resume-requested' })
          resumeRequested.add(row.sessionId)
          try {
            await controller.resolveAgent(row.sessionId)
          } catch (error: unknown) {
            // Keep the row. A resume can fail transiently while the host is still
            // starting — the controller can appear before its backends are ready — and
            // dropping the row here would lose the reminder for good. The next sweep
            // retries, and a row whose countdown really is gone gets dropped by the
            // fold check as soon as its Session is live again.
            debug('reconcile.row', { sessionId: row.sessionId, name: row.name, verdict: 'resume-failed', error: String(error) })
            continue
          }
          syncSession(row.sessionId)
          continue
        }
        const record = state.countdowns.find((candidate) => candidate.name === row.name)
        if (record === undefined || record.firedAt !== undefined) {
          debug('reconcile.row', {
            sessionId: row.sessionId,
            name: row.name,
            live: true,
            verdict: record === undefined ? 'drop-gone' : 'drop-fired',
          })
          persistRows(removeRow(pendingRows, row.sessionId, row.name))
          continue
        }
        debug('reconcile.row', { sessionId: row.sessionId, name: row.name, live: true, verdict: 'arm' })
        syncTimers(row.sessionId, state)
      }
      debug('reconcile.done')
    }

    // Sessions already resident when the plugin loads: their countdowns may be
    // pending from before a restart, and one whose instant passed while the host
    // was down fires immediately with a late note.
    for (const session of ctx.sessions.list()) syncSession(session.header.id)
    // Order matters: read the stored table first (this is what puts its rows in
    // memory), then let the live Sessions repair their own rows.
    void reconcileTable().then(() => {
      seedRows()
    })
    /**
     * The Session controller can become available *after* this plugin loads.
     *
     * Measured on a real cold start: the reconcile at load found no controller
     * (`no-controller`), the client's reconnect resumed the Session 20 seconds later,
     * and the notice — while still delivered — was not delivered by this plugin's own
     * resume. Cordis runs an `inject` callback the moment the service appears, which
     * is exactly when resuming becomes possible, so the table gets its chance then
     * instead of waiting for the next sweep.
     */
    ctx.inject(['sessionController' as never], () => {
      debug('controller.available')
      void reconcileTable()
    })
    // A Session that becomes live *after* this plugin loaded — restored from its
    // log, for instance — is where a pending countdown most often hides, because
    // the plugin cannot see a Session that is not live: `ctx.sessions.get()` does
    // not resume, and `list()` returns live entries only. Arming on this event
    // means the reminder lands as the Session comes back, not at its first step.
    const stopWatching = ctx.on('session/created', (session) => {
      syncSession(session.header.id)
    })
    // Belt and braces for a Session whose projection is not driven at load time
    // yet: a cheap sweep keeps countdowns honest without a second store.
    const sweep = setInterval(() => {
      for (const session of ctx.sessions.list()) syncSession(session.header.id)
      void reconcileTable()
    }, SWEEP_INTERVAL_MS)
    sweep.unref()
    return () => {
      stopWatching()
      clearInterval(sweep)
      for (const key of [...timers.keys()]) forget(key)
      delivered.clear()
    }
  }, 'time-reminder: countdown timers')

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
    async execute(args, exec) {
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
    async execute(args, exec) {
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

  ctx.tools.register(defineTool({
    name: TIME_COUNTDOWN_TOOL,
    description: 'Set a one-shot countdown for this session and be reminded when it comes due. By default (onFire "wake") firing starts a new turn here, so the reminder can actually be acted on; with onFire "inject" the notice only waits for this session\'s next step. Actions: start (set or replace one), snooze (move it later), cancel, list (pending only; pass includeFired for recent history). A countdown is durable across a host restart: a pending one is found again through this plugin\'s table and its session is resumed to deliver it.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'snooze', 'cancel', 'list'],
        description: 'What to do with the countdown.',
      },
      name: {
        type: 'string',
        description: 'Countdown name. Required for every action except list.',
      },
      in: {
        type: 'string',
        description: 'Delay from now, e.g. "90s", "10m", "1h30m", "2d" (start, snooze).',
      },
      at: {
        type: 'string',
        description: 'Clock time in the session zone, "HH:MM"; the next occurrence is used, so a time already past today means tomorrow (start). Give exactly one of in/at.',
      },
      onFire: {
        type: 'string',
        enum: ['wake', 'inject'],
        description: 'wake (default): firing starts a new turn in this session. inject: the notice waits for this session\'s next step instead of waking it.',
      },
      note: {
        type: 'string',
        description: 'Label carried into the notice so the reminder explains itself (start).',
      },
      includeFired: {
        type: 'boolean',
        description: 'List already-fired countdowns too, newest first and capped. Defaults to false: list shows what is still pending (list).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          now: { type: 'string', required: true },
          countdowns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                firesAt: { type: 'string', required: true },
                remaining: { type: 'string', required: true },
                onFire: { type: 'string', required: true },
                status: { type: 'string', required: true },
                note: { type: 'string' },
              },
            },
          },
          hiddenFired: { type: 'integer', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Current time: ${value.now}\n${value.countdowns.length === 0
          ? 'No countdown is pending in this session.'
          : value.countdowns.map((countdown) =>
            `- ${countdown.name}: ${countdown.remaining} (due ${countdown.firesAt})`
            + `${countdown.note === undefined ? '' : ` — ${countdown.note}`}`
            + `  [onFire=${countdown.onFire}; ${countdown.status}]`).join('\n')}`
          + `${value.hiddenFired === 0 ? '' : `\n${value.hiddenFired} fired countdown(s) hidden; pass includeFired: true to see them.`}`
          + `\n${value.note}`,
      }],
    },
    async execute(args, exec) {
      const session = requireSession(exec)
      const now = Date.now()
      const zone = displayZone([])
      // The same pure change the log fold applies, so a restored Session re-arms
      // exactly the instant this call committed.
      const change = countdownChange(stateOf(session.header.id), args, now, zone)
      // The fold commits this call once its result is logged; arming from the
      // state this call computed keeps the timer honest in the meantime. The
      // durable table follows the same commit, so a restart can find this reminder.
      if (change.reschedule) {
        syncTimers(session.header.id, change.state)
        syncRows(session.header.id, change.state)
      }
      // Fired countdowns are history: shown only when asked for, so `list` stays a
      // view of what is still owed instead of growing with every reminder answered.
      const includeFired = args.includeFired === true
      const state = change.state
      const firedCount = state.countdowns.filter((record) => record.firedAt !== undefined).length
      return {
        now: formatTimestamp(now, zone),
        countdowns: listedCountdowns(state.countdowns, includeFired).map((record) => ({
          name: record.name,
          firesAt: formatTimestamp(record.firesAt, zone),
          // A fired countdown has no "remaining"; report how long ago it went off.
          remaining: record.firedAt === undefined
            ? describeRemaining(record.firesAt, now)
            : `fired ${formatDuration(now - record.firedAt)} ago`,
          onFire: record.onFire,
          status: record.firedAt === undefined ? 'pending' : `fired ${formatTimestamp(record.firedAt, zone)}`,
          ...record.note === undefined ? {} : { note: record.note },
        })),
        hiddenFired: firedCount - (includeFired ? Math.min(firedCount, LISTED_FIRED_LIMIT) : 0),
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

/**
 * The pending rows one Session's folded state implies: every countdown it still owes.
 * @param sessionId - the Session the rows belong to.
 * @param state - that Session's folded state.
 * @returns the rows, in state order.
 */
function rowsOf(sessionId: string, state: TimeReminderState): PendingRow[] {
  const wroteAt = Date.now()
  return state.countdowns
    .filter((record) => record.firedAt === undefined)
    .map((record) => ({
      sessionId,
      name: record.name,
      firesAt: record.firesAt,
      onFire: record.onFire,
      ...record.note === undefined ? {} : { note: record.note },
      wroteAt,
    }))
}

/**
 * Resolve the durable pending-countdown table for this composition.
 *
 * The path is deployment-varying, so it is a validated `Config` field; the default
 * goes through the Host's `dshHomePath` helper rather than `os.homedir()`, so a
 * relocated `DSH_HOME` keeps the table next to the rest of the Host state.
 *
 * @param ctx - plugin context, read through `ctx.get` for the optional helper.
 * @param config - the table switch and path.
 * @returns the store, or `undefined` when this composition has no usable table.
 */
function resolvePendingStore(homePath: DshHomePathLike | undefined, ctx: Context, config: Config): PendingStore | undefined {
  if (config.pendingTable === false) return undefined
  const configured = typeof config.pendingPath === 'string' && config.pendingPath.length > 0 ? config.pendingPath : undefined
  if (configured !== undefined) return fileStore(configured)
  if (homePath === undefined) {
    // Not fatal: countdowns still work while their Session is reachable, they just
    // cannot be found after a restart in a composition that hides `<DSH_HOME>`.
    ctx.logger.warn('time-reminder: no dshHomePath in this composition, so the pending countdown table is off')
    return undefined
  }
  return fileStore(homePath('time-reminder', 'countdowns.json'))
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
