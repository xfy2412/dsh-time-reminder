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
  /**
   * Free-form label shown beside the elapsed time.
   *
   * Declared `string | undefined` rather than plain `string`: the projection
   * schema is a zod object whose inferred optional output carries `undefined`
   * explicitly, and this record is the type that schema validates into.
   */
  readonly note?: string | undefined
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

/** What happens when a countdown reaches its instant. */
export type CountdownOnFire = 'wake' | 'inject'

/**
 * What a countdown does when it fires unless the call says otherwise.
 *
 * `wake` is the default because the point of a countdown is to make something
 * happen at a time: a Session that is idle when its countdown fires is steered
 * into a new turn, which is the only way the promised action actually runs.
 * `inject` deliberately does not wake — it queues the notice for whenever the
 * Session next takes a step.
 */
export const DEFAULT_ON_FIRE: CountdownOnFire = 'wake'

/** One pending or fired countdown. */
export interface CountdownRecord {
  readonly name: string
  /** Instant it fires (or fired). */
  readonly firesAt: number
  /** Instant this record was created or last snoozed. */
  readonly setAt: number
  /** What to do at `firesAt`. */
  readonly onFire: CountdownOnFire
  /** Free-form label carried into the notice. */
  readonly note?: string | undefined
  /**
   * Instant the fire notice was logged, absent while the countdown is pending.
   *
   * The fold learns this from the notice itself rather than from a plugin-owned
   * event: the delivered message is the durable record that the countdown fired,
   * so a restarted host does not fire it a second time.
   */
  readonly firedAt?: number | undefined
}

/** What one counter call changed, as far as the related Sessions are concerned. */
export type CounterNoticeKind = 'created' | 'restarted' | 'reset' | 'relabelled' | 'visibility' | 'removed'

/** One of this plugin's tool calls whose result has not been folded yet. */
export interface PendingCall {
  readonly callId: string
  /** Tool name; only this plugin's own tools are recorded. */
  readonly tool: string
  /** Parsed `tool/call` arguments, applied when the call's result reports success. */
  readonly args: Readonly<Record<string, unknown>>
  /** Instant the call was logged; a new counter's baseline when the call commits. */
  readonly at: number
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
  /** Countdowns owned by this Session, pending and already fired. */
  readonly countdowns: readonly CountdownRecord[]
  /** Calls awaiting their result; a call commits only when that result is a success. */
  readonly pending: readonly PendingCall[]
}
