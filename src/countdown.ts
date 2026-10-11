/**
 * Pure countdown arithmetic: parse a duration or a clock time, resolve it to the
 * instant a countdown fires, and describe what is left.
 *
 * Kept free of cordis and session types so it is unit-testable, and free of any
 * ambient clock: the caller supplies `now`, exactly as `./cron.ts` does.
 *
 * Two spellings reach this module, and both must resolve to the *same* instant
 * in the live tool and in the log fold, or a restored Session would re-arm a
 * countdown that already fired:
 *
 * - a duration (`in`), which is relative to the instant the call was logged;
 * - a clock time (`at`), which is resolved in the **configured** zone, never in
 *   the request's browser zone — the fold has no request to read a browser zone
 *   from, so only the configured zone makes both paths agree.
 *
 * @module dsh-time-reminder/countdown
 */

import { formatDuration } from './reading.ts'
import type { CountdownRecord } from './types.ts'

/** Milliseconds per unit suffix accepted in a duration. */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Longest delay one `setTimeout` can express (2^31 - 1 ms, ~24.8 days).
 * Longer countdowns are armed in stages; see the caller.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Parse a duration such as `90s`, `5m`, `1h30m`, or `2d`.
 *
 * @param text - the duration spelling.
 * @returns the duration in milliseconds, always positive.
 * @throws TypeError when the text is not a sequence of `<number><unit>` tokens.
 */
export function parseDuration(text: string): number {
  const trimmed = text.trim()
  const tokens = [...trimmed.matchAll(/(\d+)([smhd])/g)]
  if (tokens.length === 0 || tokens.map((token) => token[0]).join('') !== trimmed) {
    throw new TypeError(`duration must be a sequence of <number><s|m|h|d> tokens, got ${JSON.stringify(text)}`)
  }
  let total = 0
  for (const token of tokens) total += Number(token[1]) * UNIT_MS[token[2]!]!
  if (total <= 0) throw new TypeError(`duration must be positive, got ${JSON.stringify(text)}`)
  return total
}

/** One clock time of day, as spelled by an `at` argument. */
export interface ClockTime {
  readonly hour: number
  readonly minute: number
}

/**
 * Parse a clock time such as `15:30` or `9:05`.
 *
 * Seconds are deliberately unsupported: a countdown that fires to the second
 * would need second-resolution zone arithmetic for no practical gain, and the
 * minute-resolution walk below stays cheap.
 *
 * @param text - the clock spelling.
 * @returns the hour and minute.
 * @throws TypeError when the text is not `H:MM` / `HH:MM` with a valid time of day.
 */
export function parseClockTime(text: string): ClockTime {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) throw new TypeError(`clock time must look like HH:MM, got ${JSON.stringify(text)}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new TypeError(`clock time out of range: ${JSON.stringify(text)}`)
  return { hour, minute }
}

/** Format a clock time the way {@link parseClockTime} accepts it. */
export function formatClockTime(clock: ClockTime): string {
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
}

/**
 * The first instant strictly after `now` whose local time in `timeZone` is `clock`.
 *
 * Walks whole minutes (at most two days of them, so a DST jump cannot spin here),
 * which is how `./cron.ts` resolves occurrences too: zone arithmetic through
 * `Intl`, never through a fixed offset.
 *
 * @param clock - the local time of day to hit.
 * @param timeZone - IANA zone the clock time is expressed in.
 * @param now - instant to search forward from.
 * @returns the epoch milliseconds of that instant.
 * @throws TypeError when two days pass without a match, which means a corrupt zone.
 */
export function nextClockInstant(clock: ClockTime, timeZone: string, now: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const stepMs = 60_000
  const limit = now + 2 * 86_400_000
  for (let at = Math.floor(now / stepMs) * stepMs + stepMs; at <= limit; at += stepMs) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]))
    if (Number(parts.hour) === clock.hour && Number(parts.minute) === clock.minute) return at
  }
  throw new TypeError(`no ${formatClockTime(clock)} occurrence within two days in zone ${JSON.stringify(timeZone)}`)
}

/** The two spellings a `time_countdown start` accepts, exactly one of which is required. */
export interface FireSpec {
  /** Relative duration, e.g. `5m`. */
  readonly in?: string | undefined
  /** Absolute clock time of day in the configured zone, e.g. `15:30`. */
  readonly at?: string | undefined
}

/**
 * Resolve when a countdown fires.
 *
 * @param spec - the `in` / `at` pair as the model supplied it.
 * @param now - instant the call was logged; the baseline for `in`.
 * @param timeZone - configured zone, the one `at` is expressed in.
 * @returns the instant the countdown fires.
 * @throws TypeError when neither or both spellings are present, or either is malformed.
 */
export function resolveFiresAt(spec: FireSpec, now: number, timeZone: string): number {
  const hasIn = typeof spec.in === 'string' && spec.in.trim().length > 0
  const hasAt = typeof spec.at === 'string' && spec.at.trim().length > 0
  if (hasIn === hasAt) {
    throw new TypeError('a countdown needs exactly one of "in" (e.g. "10m") or "at" (e.g. "15:30")')
  }
  return hasIn
    ? now + parseDuration(spec.in!)
    : nextClockInstant(parseClockTime(spec.at!), timeZone, now)
}

/**
 * How many already-fired countdowns an explicit `list … includeFired` shows.
 *
 * History is asked for deliberately, and a long Session can fire many countdowns;
 * the most recent ones are the ones worth reading.
 */
export const LISTED_FIRED_LIMIT = 10

/**
 * The countdowns one `list` call shows.
 *
 * Pending ones always come first and in firing order, because that is what the model
 * acts on. Fired ones are history: hidden unless asked for, then newest first and
 * capped, so a Session that fired twenty reminders does not answer `list` with twenty
 * lines. They are never deleted from the state — that record is what makes a later
 * `snooze` of an already-fired countdown possible, and it is the only in-Session
 * answer to "did that reminder actually go off?".
 *
 * @param records - every countdown the folded state holds.
 * @param includeFired - whether the caller asked for the fired history.
 * @returns the rows to render, pending first.
 */
export function listedCountdowns(records: readonly CountdownRecord[], includeFired: boolean): CountdownRecord[] {
  const byFiresAt = (left: CountdownRecord, right: CountdownRecord): number => left.firesAt - right.firesAt
  const pending = records.filter((record) => record.firedAt === undefined).sort(byFiresAt)
  if (!includeFired) return pending
  const fired = records
    .filter((record) => record.firedAt !== undefined)
    .sort((left, right) => byFiresAt(right, left))
    .slice(0, LISTED_FIRED_LIMIT)
  return [...pending, ...fired]
}

/**
 * How long is left, as the model-facing phrase used by readings and by the tool.
 * @param firesAt - instant the countdown fires.
 * @param now - sampled instant.
 * @returns `in 4m30s` while pending, `due` at the instant, `overdue by 2m` after it.
 */
export function describeRemaining(firesAt: number, now: number): string {
  const remaining = firesAt - now
  if (remaining > 0) return `in ${formatDuration(remaining)}`
  if (remaining === 0) return 'due now'
  return `overdue by ${formatDuration(-remaining)}`
}
