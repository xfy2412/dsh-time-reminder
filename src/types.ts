/**
 * Types shared by every module in this package.
 *
 * Types only — no runtime code — so pure modules (visibility, reading) and their
 * tests can import them without pulling in schemastery or zod.
 *
 * @module dsh-time-reminder/types
 */

/** Time mode controlling automatic injection; each Session owns its own value. */
export type TimeMode = 'off' | 'cron' | 'turn' | 'fine'

/** Scope policy for one counter: whether it crosses a lineage boundary, and how far. */
export interface CounterScope {
  /** Whether Sessions delegated from this one may read it. */
  readonly toChildren: boolean
  /** Whether this Session's ancestors may read it. */
  readonly toParents: boolean
  /**
   * How many lineage generations the two exposure flags reach, counted as
   * generations away: `1` is a direct parent or child, `2` also reaches a
   * grandparent or grandchild.
   */
  readonly depth: number
}

/** One named elapsed-time counter. */
export interface CounterRecord {
  readonly name: string
  /** Baseline instant the elapsed time is measured from. */
  readonly startedAt: number
  /** Free-form label shown beside the elapsed time. */
  readonly note?: string
  /** Whether this counter joins every automatic reading. */
  readonly inject: boolean
  readonly scope: CounterScope
}

/**
 * Default scope for a new counter: exposed downward two generations (child and
 * grandchild), never upward.
 */
export const DEFAULT_COUNTER_SCOPE: CounterScope = {
  toChildren: true,
  toParents: false,
  depth: 2,
}

/** Whole per-Session state. */
export interface TimeReminderState {
  readonly mode: TimeMode
  /** Cron expression in force for this Session, independent of the configured default. */
  readonly cron: string
  /** Instant of this plugin's latest reading in this Session. */
  readonly lastInjectionAt: number | null
  /** Instant of the latest reading in the open turn. */
  readonly lastTurnInjectionAt: number | null
  /** Instant of the latest model-visible message; the step-1 baseline. */
  readonly lastMessageAt: number | null
  readonly counters: readonly CounterRecord[]
}
