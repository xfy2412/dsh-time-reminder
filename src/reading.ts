/**
 * Pure rendering of this plugin's model-facing text: one time reading, and the
 * counter notices delivered to related Sessions.
 *
 * Kept free of cordis and session types so it can be tested directly: the caller
 * supplies the instant, the resolved display zone, the mode decision, and the
 * elapsed baselines.
 *
 * @module dsh-time-reminder/reading
 */

import { describeCron, latestOccurrence, type CronExpression } from './cron.ts'
import type { CounterNoticeKind, CounterRecord, TimeMode } from './types.ts'

export type { TimeMode } from './types.ts'

/** Opening tag of the framing the model reads as system context rather than user speech. */
const SYSTEM_REMINDER_OPEN = '<system-reminder>'

/** Closing tag of that framing. */
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * How late a fire must be before the notice mentions it.
 *
 * A timer that goes off a few milliseconds after its instant is punctual; saying
 * so in the notice would be noise, and `formatDuration` would render it as the
 * misleading `0s late`.
 */
const LATE_NOTICE_MS = 2_000

/**
 * Why a countdown notice did not reach the model at the instant the countdown was due.
 *
 * Every field is something the plugin **observes** at fire time rather than
 * guesses: `lateMs` is measured on the timer callback, `caughtUp` records that
 * the timer was armed only after its instant had already passed, `sessionBusy` is
 * the owning Agent's own status, and `resumedHere` is the plugin's own record of
 * having asked the Host to resume this Session.
 *
 * `resumedHere` exists because a resumed Session looks identical from the outside
 * no matter who asked for it — the client reconnecting, the user opening it, or
 * this plugin's table reconcile all leave one `session/created` event. Only the
 * plugin knows whether *it* sent the request, so only the plugin can say so.
 */
export interface CountdownFireCause {
  /** Milliseconds the timer callback ran after `firesAt`; `0` when punctual. */
  readonly lateMs: number
  /** The timer was armed only once the instant had passed: nothing was running to fire it. */
  readonly caughtUp: boolean
  /** The owning Agent was mid-turn, so the notice waits for the next step boundary. */
  readonly sessionBusy: boolean
  /** This plugin asked the Host to resolve or resume the Session before delivering. */
  readonly resumedHere: boolean
}

/** One counter scheduled to appear in the reading. */
export interface CounterLine {
  readonly name: string
  readonly elapsedMs: number
  readonly note?: string
}

/** One pending countdown, as the reading lists it so the model plans around it. */
export interface CountdownLine {
  readonly name: string
  /** Milliseconds until it fires; negative once overdue. */
  readonly inMs: number
  readonly note?: string
}

/** Everything a reading needs, with no ambient state. */
export interface ReadingInput {
  readonly now: number
  readonly turn: number
  readonly step: number
  /** Resolved display zone (the caller has already applied its fallback). */
  readonly zone: string
  /** Mode in force for this Session; `off` never renders. */
  readonly mode: Exclude<TimeMode, 'off'>
  /** Cron schedule, described in the text so the model knows the cadence. */
  readonly cron: CronExpression
  /** Whether this is the first step of its turn, which changes the elapsed baseline. */
  readonly fresh: boolean
  /** Elapsed since the preceding model-visible message; first step only. */
  readonly sinceMessageMs?: number
  /**
   * Elapsed since the preceding model-visible message, reported on any step.
   *
   * `turn` mode injects once per turn, so this is the only baseline it can offer —
   * it answers "how long since the previous turn stopped". Other modes use
   * {@link sinceMessageMs} / {@link sinceReadingMs}, which distinguish the first
   * step from later ones.
   */
  readonly sinceLastMessageMs?: number
  /** Elapsed since the preceding reading in this turn; later steps only. */
  readonly sinceReadingMs?: number
  /** Instant of the previous reading, shown for `cron` mode's traceability. */
  readonly lastInjectionAt?: number
  /** Counters whose policy asks for automatic exposure. */
  readonly counters: readonly CounterLine[]
  /** Pending countdowns, nearest first; the model sees what it has scheduled. */
  readonly countdowns?: readonly CountdownLine[]
}

/** Canonicalize an IANA zone, or reject it. */
export function canonicalTimeZone(value: string): string {
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  if (canonical !== value) {
    throw new TypeError(`time zone must be canonical IANA Area/Location: ${JSON.stringify(value)}`)
  }
  return value
}

/** Format one instant as an ISO-shaped timestamp with numeric offset and IANA zone. */
export function formatTimestamp(at: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]))
  const offset = parts.timeZoneName!.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${timeZone}]`
}

/** Render a compact whole-second duration. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/** Describe a schedule for the model-facing line; one home, in `./cron.ts`. */
export const describeSchedule = describeCron

/**
 * Decide whether a `cron`-mode step is due.
 * @param expression - the schedule.
 * @param timeZone - the zone the schedule is interpreted in.
 * @param lastInjectionAt - instant of this Session's last reading, if any.
 * @param now - the instant under test.
 * @returns whether an occurrence has been crossed since the last reading.
 */
export function cronDue(
  expression: CronExpression,
  timeZone: string,
  lastInjectionAt: number | undefined,
  now: number,
): boolean {
  // Without a baseline nothing has been crossed, so the first reading of a Session
  // is always due: the model needs a starting clock.
  if (lastInjectionAt === undefined) return true
  return latestOccurrence(expression, lastInjectionAt, now, timeZone) !== undefined
}

/**
 * Render the reading text.
 * @param input - the instant, mode, baselines, and counters.
 * @returns the exact model-facing message body.
 */
export function renderReading(input: ReadingInput): string {
  const lines = [
    `Time sampled while preparing turn ${input.turn}, step ${input.step}: ${formatTimestamp(input.now, input.zone)}`,
  ]
  switch (input.mode) {
    case 'cron': {
      const last = input.lastInjectionAt === undefined
        ? 'no earlier reading'
        : formatTimestamp(input.lastInjectionAt, input.zone)
      lines.push(`Time mode: cron (${describeSchedule(input.cron, input.zone)}; previous reading ${last})`)
      break
    }
    case 'turn':
      lines.push('Time mode: turn (one reading at the first step of every turn)')
      break
    case 'fine':
      lines.push(`Time mode: fine (a reading accompanies every step; zone ${input.zone})`)
      break
  }
  if (input.sinceLastMessageMs !== undefined) {
    lines.push(`Elapsed since the preceding model-visible message: ${formatDuration(input.sinceLastMessageMs)}`)
  } else {
    const since = input.fresh ? input.sinceMessageMs : input.sinceReadingMs
    lines.push(input.fresh
      ? `Elapsed since the preceding model-visible message: ${since === undefined ? 'unavailable' : formatDuration(since)}`
      : `Elapsed since the preceding step context: ${since === undefined ? 'unavailable' : formatDuration(since)}`)
  }
  if (input.counters.length > 0) {
    lines.push(`[counters] ${input.counters.map((counter) =>
      `${counter.name}=${formatDuration(counter.elapsedMs)}${counter.note === undefined ? '' : ` (${counter.note})`}`).join('  ')}`)
  }
  if (input.countdowns !== undefined && input.countdowns.length > 0) {
    lines.push(`[countdowns] ${input.countdowns.map((countdown) =>
      `${countdown.name} in ${formatDuration(Math.max(0, countdown.inMs))}${countdown.note === undefined ? '' : ` (${countdown.note})`}`).join('  ')}`)
  }
  return lines.join('\n')
}

/**
 * Frame a reading as a system-reminder block.
 *
 * The model then reads it as system context rather than as something the user
 * said. The framing mirrors the workspace-instruction injection, including its
 * escaping rule: a body that could close the frame early (a counter note is
 * free-form user text) has that tag escaped instead.
 *
 * @param text - the rendered reading body.
 * @returns the framed model-facing message text.
 */
export function systemReminderBlock(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${text.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')}\n${SYSTEM_REMINDER_CLOSE}`
}

/**
 * One-line account of a reading for the collapsed context row.
 *
 * The row shows this without expanding, so it has to name the fact that matters
 * at a glance: what kind of reading arrived, and when.
 *
 * @param mode - mode that produced the reading.
 * @param at - the sampled instant.
 * @param timeZone - resolved display zone.
 * @returns the collapsed-row summary.
 */
export function readingSummary(mode: TimeMode, at: number, timeZone: string): string {
  return `${mode} reading · ${formatTimestamp(at, timeZone)}`
}

/**
 * Model-facing text of one countdown notice.
 *
 * It is the message the Session asked for when it set the countdown, so it says
 * what the countdown was for, when it was due, and — when something kept it from
 * arriving on time — the specific reason, because a model that believes a
 * reminder is punctual will mis-plan the work around it.
 *
 * The reason comes from {@link CountdownFireCause}, which is observed rather than
 * guessed: a timer armed after its instant means nothing was running to fire it;
 * a late callback means the process was suspended or blocked; a running Agent
 * means this Session was mid-step and the notice had to wait for that step to end.
 * Those two can both be true, so the clauses are independent. A punctual fire into
 * an idle Session adds nothing — there is no delay to explain.
 *
 * @param name - the countdown's name.
 * @param note - the label the Session attached when setting it, if any.
 * @param firesAt - the instant it was due.
 * @param timeZone - resolved display zone.
 * @param cause - what the plugin observed at fire time.
 * @returns the notice body, without the `<system-reminder>` framing.
 */
export function countdownNoticeText(
  name: string,
  note: string | undefined,
  firesAt: number,
  timeZone: string,
  cause: CountdownFireCause,
): string {
  const label = note === undefined ? '' : ` (${note})`
  const clauses: string[] = []
  if (cause.caughtUp) {
    // Observed fact: the timer was armed only after the instant had passed. The
    // reason is deliberately not narrowed to "the host was down" — the same
    // observation also covers a session whose projection had not been driven yet
    // when the plugin loaded, where the host was up all along.
    clauses.push(`It came due before this session's countdown timers were running again, so this is the first chance to deliver it (${formatDuration(cause.lateMs)} late).`)
  } else if (cause.lateMs >= LATE_NOTICE_MS) {
    clauses.push(`The timer went off ${formatDuration(cause.lateMs)} late, so the process was suspended or blocked at that instant.`)
  }
  if (cause.sessionBusy) {
    clauses.push('This session was in the middle of a step, so the notice waited for that step to end.')
  }
  if (cause.resumedHere) {
    clauses.push('This session was not live, so this plugin asked the host to resume it in order to deliver the reminder.')
  }
  const reason = clauses.length === 0 ? '' : ` ${clauses.join(' ')}`
  return `[countdown] "${name}"${label} was due at ${formatTimestamp(firesAt, timeZone)} and has fired now.${reason}`
}

/**
 * Model-facing notice that a counter changed in a related Session.
 *
 * It is delivered to the Sessions a counter reaches or just left, so it states
 * what those Sessions cannot see for themselves: who owns the counter, whether it
 * joins their readings, and how far its scope reaches.
 *
 * @param kind - what the owning Session did to the counter.
 * @param counter - the counter as committed by that call.
 * @param ownerSessionId - the Session that made the change.
 * @param timeZone - the owner's resolved display zone.
 * @returns the notice body, without the `<system-reminder>` framing.
 */
export function counterNoticeText(kind: CounterNoticeKind, counter: CounterRecord, ownerSessionId: string, timeZone: string): string {
  const note = counter.note === undefined ? '' : ` (${counter.note})`
  const scope = `children=${counter.scope.toChildren}; parents=${counter.scope.toParents}; depth=${counter.scope.depth}`
  const reading = counter.inject ? 'it joins your readings' : 'it stays out of your readings'
  switch (kind) {
    case 'created':
      return `[counters] "${counter.name}"${note} was created by session ${ownerSessionId} at ${formatTimestamp(counter.startedAt, timeZone)}; `
        + `${reading} while it stays visible (${scope}).`
    case 'restarted':
      return `[counters] "${counter.name}"${note} was restarted by session ${ownerSessionId}; its baseline is now `
        + `${formatTimestamp(counter.startedAt, timeZone)} (${scope}).`
    case 'reset':
      return `[counters] "${counter.name}"${note} was reset by session ${ownerSessionId}; its baseline is now `
        + `${formatTimestamp(counter.startedAt, timeZone)}.`
    case 'relabelled':
      return `[counters] "${counter.name}" was relabelled by session ${ownerSessionId} to ${JSON.stringify(counter.note ?? '')}.`
    case 'visibility':
      return `[counters] "${counter.name}"${note} changed visibility (${scope}); ${reading}.`
    case 'removed':
      return `[counters] "${counter.name}"${note} was removed by session ${ownerSessionId}; it leaves your readings too.`
  }
}
