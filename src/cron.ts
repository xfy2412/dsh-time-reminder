/**
 * Minimal 5-field cron parsing and previous-occurrence resolution.
 *
 * Deliberately self-contained: @deepseek-ai/dsh-schedule owns the full cron
 * implementation but is a private workspace package, so a plugin installed into a
 * profile cannot resolve it. Only the semantics this plugin needs are implemented
 * here — fields `minute hour day-of-month month day-of-week`, the `@daily` family
 * of macros, and resolution of the latest occurrence at or before an instant.
 *
 * Supported per field: `*`, a literal, `a-b`, `a-b/n`, a bare star with a step, and
 * comma lists of those. Day-of-month and day-of-week follow Vixie cron: when both
 * are restricted they are OR-ed, otherwise the restricted one alone decides.
 *
 * @module dsh-time-reminder/cron
 */

/** One parsed cron expression. */
export interface CronExpression {
  /** The canonical expression text this was parsed from. */
  readonly text: string
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  readonly daysOfWeek: readonly number[]
}

/** Named schedules accepted in place of a five-field expression. */
const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
  /** Whether `7` is accepted as a second spelling of Sunday. */
  readonly aliasesSunday?: boolean
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6, aliasesSunday: true },
]

/**
 * Parse one cron expression.
 * @param expression - five fields separated by whitespace, or a `@daily`-style macro.
 * @returns the parsed expression.
 * @throws TypeError when the expression is not a supported cron schedule.
 */
export function parseCron(expression: string): CronExpression {
  const trimmed = expression.trim()
  if (trimmed.length === 0) throw new TypeError('cron expression must not be blank')
  const macro = MACROS[trimmed.toLowerCase()]
  const text = macro ?? trimmed
  const parts = text.split(/\s+/)
  if (parts.length !== FIELDS.length) {
    throw new TypeError(`cron expression must have ${FIELDS.length} fields, got ${parts.length}: ${JSON.stringify(expression)}`)
  }
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index]!))
  return {
    text,
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
  }
}

/** Parse one field into its sorted, duplicate-free value list. */
function parseField(raw: string, spec: FieldSpec): number[] {
  const values = new Set<number>()
  for (const item of raw.split(',')) {
    if (item.length === 0) throw new TypeError(`cron ${spec.name} field has an empty list item: ${JSON.stringify(raw)}`)
    const [rangePart, stepPart, ...extra] = item.split('/')
    if (extra.length > 0) throw new TypeError(`cron ${spec.name} field has more than one step: ${JSON.stringify(item)}`)
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isSafeInteger(step) || step < 1) {
        throw new TypeError(`cron ${spec.name} step must be a positive integer: ${JSON.stringify(item)}`)
      }
    }
    const range = rangePart!
    let start: number
    let end: number
    if (range === '*') {
      start = spec.min
      end = spec.max
    } else {
      const bounds = range.split('-')
      if (bounds.length > 2) throw new TypeError(`cron ${spec.name} range is malformed: ${JSON.stringify(item)}`)
      start = readValue(bounds[0]!, spec)
      end = bounds.length === 2 ? readValue(bounds[1]!, spec) : start
      if (end < start) throw new TypeError(`cron ${spec.name} range is descending: ${JSON.stringify(item)}`)
      // A bare value with a step means "from here to the field maximum".
      if (bounds.length === 1 && stepPart !== undefined) end = spec.max
    }
    for (let value = start; value <= end; value += step) values.add(normalizeWeekday(value, spec))
  }
  if (values.size === 0) throw new TypeError(`cron ${spec.name} field selects no value: ${JSON.stringify(raw)}`)
  return [...values].sort((left, right) => left - right)
}

/** Read one numeric field value, validating range and the Sunday aliases. */
function readValue(token: string, spec: FieldSpec): number {
  if (!/^\d{1,2}$/.test(token)) throw new TypeError(`cron ${spec.name} value is not a number: ${JSON.stringify(token)}`)
  const value = Number(token)
  const allowed = spec.aliasesSunday === true ? spec.max + 1 : spec.max
  if (value < spec.min || value > allowed) {
    throw new TypeError(`cron ${spec.name} value is out of range ${spec.min}-${allowed}: ${JSON.stringify(token)}`)
  }
  return value
}

/** Fold the Sunday alias onto its canonical value. */
function normalizeWeekday(value: number, spec: FieldSpec): number {
  return spec.aliasesSunday === true && value === 7 ? 0 : value
}

/** Whether a field was written as `*` (or a macro equivalent), which Vixie cron treats as unrestricted. */
function unrestricted(raw: string): boolean {
  return raw === '*'
}

/**
 * Resolve the latest occurrence strictly after `after` and at or before `before`.
 *
 * Returns `undefined` when no occurrence falls in that window, which is the normal
 * outcome for a daily schedule checked within the same day it last fired.
 *
 * @param expression - the parsed schedule.
 * @param after - exclusive lower bound in epoch milliseconds.
 * @param before - inclusive upper bound in epoch milliseconds (usually "now").
 * @param timeZone - IANA zone the schedule is interpreted in.
 * @returns the epoch milliseconds of the latest matching minute, or `undefined`.
 */
export function latestOccurrence(
  expression: CronExpression,
  after: number,
  before: number,
  timeZone: string,
): number | undefined {
  if (before <= after) return undefined
  const fields = expression.text.split(/\s+/)
  const domRestricted = !unrestricted(fields[2]!)
  const dowRestricted = !unrestricted(fields[4]!)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  // Walk whole minutes downward from `before` to `after`. A daily schedule costs at
  // most one day of minutes; the guard bounds work for a pathological window.
  const stepMs = 60_000
  const start = Math.floor(before / stepMs) * stepMs
  const limit = Math.max(after, before - 400 * 24 * 60 * stepMs)
  for (let at = start; at > limit; at -= stepMs) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]))
    const minute = Number(parts.minute)
    const hour = Number(parts.hour)
    const dayOfMonth = Number(parts.day)
    const month = Number(parts.month)
    const dayOfWeek = weekdayOf(at, timeZone)
    if (!expression.minutes.includes(minute)) continue
    if (!expression.hours.includes(hour)) continue
    if (!expression.months.includes(month)) continue
    const domMatch = expression.daysOfMonth.includes(dayOfMonth)
    const dowMatch = expression.daysOfWeek.includes(dayOfWeek)
    const dayMatch = domRestricted && dowRestricted
      ? domMatch || dowMatch
      : domRestricted
        ? domMatch
        : dowRestricted
          ? dowMatch
          : true
    if (!dayMatch) continue
    if (at > after) return at
  }
  return undefined
}

/** Read the local day of week (0 = Sunday) for one instant in one zone. */
function weekdayOf(at: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at)
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name)
  if (index < 0) throw new TypeError(`unexpected weekday name ${JSON.stringify(name)}`)
  return index
}

/**
 * Describe a schedule for the model-facing reading line.
 *
 * The phrasing answers the question a reading actually raises — "how soon will
 * the next one come, and when?" — so recurring shapes are named rather than
 * echoed: `every 2 minutes`, `hourly at :15`, `daily 03:30`. A schedule with a
 * day, month, or weekday restriction keeps its raw expression, because folding
 * those into prose risks dropping a constraint the model would then mis-plan on.
 *
 * @param expression - the parsed schedule.
 * @param timeZone - the zone the schedule is interpreted in.
 * @returns human-readable schedule text.
 */
export function describeCron(expression: CronExpression, timeZone: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.text.split(/\s+/)
  const minuteNumber = plainNumber(minute)
  const hourNumber = plainNumber(hour)
  const minuteStep = stepOf(minute)
  const hourStep = stepOf(hour)
  const everyDay = dayOfMonth === '*' && month === '*' && dayOfWeek === '*'
  if (everyDay) {
    if (minute === '*' && hour === '*') return `every minute ${timeZone}`
    if (minuteStep === 1 && hour === '*') return `every minute ${timeZone}`
    if (minuteStep !== undefined && hour === '*') return `every ${minuteStep} minutes ${timeZone}`
    if (hourStep !== undefined && minuteNumber !== undefined) {
      return hourStep === 1
        ? `hourly at :${pad(minuteNumber)} ${timeZone}`
        : `every ${hourStep} hours at :${pad(minuteNumber)} ${timeZone}`
    }
    if (minuteNumber !== undefined && hour === '*') return `hourly at :${pad(minuteNumber)} ${timeZone}`
    if (minuteNumber !== undefined && hourNumber !== undefined) return `daily ${pad(hourNumber)}:${pad(minuteNumber)} ${timeZone}`
  }
  return `${expression.text} ${timeZone}`
}

/** A field that is nothing but a number, or undefined. */
function plainNumber(field: string | undefined): number | undefined {
  return field !== undefined && /^\d{1,2}$/.test(field) ? Number(field) : undefined
}

/** The step size of a `*​/n` field, or undefined for any other spelling. */
function stepOf(field: string | undefined): number | undefined {
  const match = field === undefined ? null : /^\*\/(\d{1,2})$/.exec(field)
  return match === null ? undefined : Number(match[1])
}

/** Two-digit clock field. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}
