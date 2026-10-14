/**
 * The log fold that rebuilds per-Session state.
 *
 * Why this file exists: the plugin must not write its own event type (DSH has no
 * public API that marks an event `ignorable`, and an unknown required type makes
 * the stored Session unreadable on reload). State is therefore derived from
 * events the plugin already produces, and these tests pin the derivation:
 * a call commits only on success, an injected reading dates `lastInjectionAt`,
 * and an invalid call leaves the state alone instead of throwing — a fold that
 * throws would take the Session with it.
 *
 * @module dsh-time-reminder/tests/state-fold.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionEvent,
  counterChange,
  initialState,
  type SessionEventLike,
} from '../src/fold.ts'
import { DEFAULT_COUNTER_SCOPE, type TimeReminderState } from '../src/types.ts'

/** The state a fresh Session folds to. */
const fresh = (): TimeReminderState => initialState('cron', '0 0 * * *')

/** Zone the fold resolves a countdown's `at` argument in (the configured zone). */
const ZONE = 'Asia/Shanghai'

/** Fold a whole log. */
const fold = (events: readonly SessionEventLike[], from = fresh()): TimeReminderState =>
  events.reduce((state, event) => applySessionEvent(state, event, ZONE), from)

/** One of this plugin's tool calls. */
const call = (seq: number, time: number, name: string, args: Record<string, unknown>): SessionEventLike => ({
  type: 'tool/call',
  time,
  data: { turn: 1, step: 1, callId: `call_${seq}`, name, arguments: JSON.stringify(args) },
})

/** The matching result; `isError` marks a call that failed. */
const result = (seq: number, time: number, isError = false): SessionEventLike => ({
  type: 'tool/result',
  time,
  data: { turn: 1, step: 1, message: { toolCallId: `call_${seq}`, isError, content: [] } },
})

/** One reading injected by this plugin; the `notice` form is what marks it as one. */
const reading = (time: number): SessionEventLike => ({
  type: 'user/message',
  time,
  data: { role: 'user', content: [{ type: 'text', text: 'Time sampled…' }], source: { kind: 'dsh-time-reminder', form: 'notice' } },
})

/**
 * One countdown fire notice.
 *
 * It is a `notice` too, and that is the point: the `countdown` marker in the
 * source is the only thing separating it from a reading.
 */
const fireNotice = (time: number, name: string): SessionEventLike => ({
  type: 'user/message',
  time,
  data: {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>[countdown] "${name}" has fired.</system-reminder>` }],
    source: { kind: 'dsh-time-reminder', form: 'notice', countdown: name },
  },
})

/**
 * One mode change made by the user from the GUI card.
 *
 * It carries the `notice` form (so the GUI can show its one-line summary) and is
 * identified by the `mode` field — the same shape as a countdown notice, and for the
 * same reason: `ContextFormed` is a fixed harness union and refuses a producer form.
 */
const modeChange = (time: number, mode: string, cron?: string): SessionEventLike => ({
  type: 'user/message',
  time,
  data: {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>[time] The user set this session's time mode to "${mode}".</system-reminder>` }],
    source: { kind: 'dsh-time-reminder', form: 'notice', mode, ...cron === undefined ? {} : { cron } },
  },
})

test('a GUI mode change switches the mode without spending the reading baselines', () => {
  const state = fold([
    reading(1_000),
    modeChange(2_000, 'fine'),
  ])
  assert.equal(state.mode, 'fine')
  assert.equal(state.lastInjectionAt, 1_000, 'the switch itself is not a reading')
  assert.equal(state.lastTurnInjectionAt, 1_000)
  assert.equal(state.cron, '0 0 * * *', 'the schedule survives a mode switch')
})

test('a GUI mode change wins over the reading branch it shares a form with', () => {
  // Same event, only the source differs: one is a reading, the other a mode change.
  const asReading = fold([reading(5_000)])
  const asMode = fold([modeChange(5_000, 'turn')])
  assert.equal(asReading.mode, 'cron', 'the reading leaves the mode alone')
  assert.equal(asReading.lastInjectionAt, 5_000)
  assert.equal(asMode.mode, 'turn', 'the mode change switches the mode')
  assert.equal(asMode.lastInjectionAt, null, 'and does not date the baselines')
})

test('an unreadable mode in the log is ignored rather than failing the fold', () => {
  const state = fold([
    reading(7_000),
    modeChange(8_000, 'whenever'),
  ])
  assert.equal(state.mode, 'cron')
  assert.equal(state.lastInjectionAt, 7_000, 'the message still counts as nothing at all')
})

test('a GUI mode change carries the new schedule the same way a time_mode call does', () => {
  const state = fold([modeChange(2_000, 'cron', '*/5 * * * *')])
  assert.equal(state.mode, 'cron')
  assert.equal(state.cron, '*/5 * * * *')
})

test('an unreadable schedule in the log keeps the old one instead of failing the fold', () => {
  const state = fold([modeChange(2_000, 'cron', 'every other tuesday')])
  assert.equal(state.mode, 'cron', 'the mode still applies')
  assert.equal(state.cron, '0 0 * * *', 'the unparseable expression is ignored')
})

test('a successful time_mode call commits its mode and schedule', () => {
  const state = fold([
    call(1, 100, 'time_mode', { mode: 'turn' }),
    result(1, 110),
  ])
  assert.equal(state.mode, 'turn')
  assert.equal(state.cron, '0 0 * * *')
  assert.deepEqual(state.pending, [])
})

test('time_mode commits a new cron expression only once its result arrives', () => {
  const pending = fold([call(1, 100, 'time_mode', { mode: 'cron', cron: '*/5 * * * *' })])
  assert.equal(pending.cron, '0 0 * * *')
  assert.equal(pending.pending.length, 1)
  const committed = applySessionEvent(pending, result(1, 110), ZONE)
  assert.equal(committed.cron, '*/5 * * * *')
})

test('a failed call commits nothing and drops its record', () => {
  const state = fold([
    call(1, 100, 'time_mode', { mode: 'fine' }),
    result(1, 110, true),
  ])
  assert.equal(state.mode, 'cron')
  assert.deepEqual(state.pending, [])
})

test('an invalid mode or cron expression is dropped instead of throwing', () => {
  const state = fold([
    call(1, 100, 'time_mode', { mode: 'sometimes' }),
    result(1, 110),
    call(2, 120, 'time_mode', { mode: 'cron', cron: 'not a cron' }),
    result(2, 130),
  ])
  assert.equal(state.mode, 'cron')
  assert.equal(state.cron, '0 0 * * *')
})

test('another tool\'s call is never recorded', () => {
  const state = fold([
    call(1, 100, 'pwsh', { command: 'echo hi' }),
    result(1, 110),
  ])
  assert.deepEqual(state.pending, [])
})

test('a counter starts at the instant its call was logged', () => {
  const state = fold([
    call(1, 5_000, 'time_counter', { action: 'start', name: 'deploy', note: '开始部署', inject: true }),
    result(1, 5_010),
  ])
  assert.deepEqual(state.counters, [{
    name: 'deploy',
    startedAt: 5_000,
    note: '开始部署',
    inject: true,
    scope: { toChildren: true, toParents: false, depth: 2 },
  }])
})

test('counter note, scope, and remove follow the same call-then-result path', () => {
  const started = fold([
    call(1, 1_000, 'time_counter', { action: 'start', name: 'deploy' }),
    result(1, 1_010),
    call(2, 2_000, 'time_counter', { action: 'note', name: 'deploy', note: '发布' }),
    result(2, 2_010),
    call(3, 3_000, 'time_counter', { action: 'scope', name: 'deploy', toParents: true, depth: 1 }),
    result(3, 3_010),
  ])
  assert.equal(started.counters[0]?.note, '发布')
  assert.deepEqual(started.counters[0]?.scope, { toChildren: true, toParents: true, depth: 1 })
  const removed = applySessionEvent(started, call(4, 4_000, 'time_counter', { action: 'remove', name: 'deploy' }), ZONE)
  assert.deepEqual(applySessionEvent(removed, result(4, 4_010), ZONE).counters, [])
})

test('a counter action naming a missing counter changes nothing', () => {
  const state = fold([
    call(1, 1_000, 'time_counter', { action: 'reset', name: 'ghost' }),
    result(1, 1_010),
  ])
  assert.deepEqual(state.counters, [])
})

test('an injected reading dates lastInjectionAt, but not the message baseline', () => {
  const state = fold([reading(7_000)])
  assert.equal(state.lastInjectionAt, 7_000)
  assert.equal(state.lastTurnInjectionAt, 7_000)
  assert.equal(state.lastMessageAt, null)
})

test('a user message that is not this plugin\'s reading is ignored', () => {
  const state = fold([{
    type: 'user/message',
    time: 7_000,
    data: { role: 'user', content: [], source: { kind: 'user', rpcId: 'rpc' } },
  }])
  assert.equal(state.lastInjectionAt, null)
  assert.equal(state.lastMessageAt, null)
})

test('model-visible messages supply the step-1 baseline', () => {
  const state = fold([
    { type: 'assistant/message', time: 8_000, data: { turn: 1, step: 1 } },
    { type: 'tool/result', time: 9_000, data: { turn: 1, step: 2, message: { toolCallId: 'x', isError: false } } },
  ])
  assert.equal(state.lastMessageAt, 9_000)
})

test('a turn boundary clears the open-turn reading and any unpaired call', () => {
  const before = fold([reading(7_000), call(1, 7_100, 'time_mode', { mode: 'fine' })])
  assert.equal(before.lastTurnInjectionAt, 7_000)
  const after = applySessionEvent(before, { type: 'turn/end', time: 7_200, data: { turn: 1 } }, ZONE)
  assert.equal(after.lastTurnInjectionAt, null)
  assert.deepEqual(after.pending, [])
  assert.equal(after.lastInjectionAt, 7_000)
})

test('folding the same log twice reaches the same state', () => {
  const log = [
    reading(1_000),
    call(1, 1_100, 'time_counter', { action: 'start', name: 'deploy' }),
    result(1, 1_110),
    { type: 'assistant/message', time: 1_200, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 1_300, data: { turn: 1 } },
    call(2, 1_400, 'time_mode', { mode: 'fine' }),
    result(2, 1_410),
    reading(1_500),
  ]
  assert.deepEqual(fold(log), fold(log))
})

test('the fold covers every field the projection schema declares', () => {
  // The schema itself lives in `../src/state.ts`, which needs `zod`; the DSH
  // runtime validates the folded state with it on every apply, so a field added
  // here without a matching schema entry fails loudly at load rather than
  // silently dropping state. This test pins the field set instead of the schema.
  const folded = fold([
    reading(1_000),
    call(1, 1_100, 'time_counter', { action: 'start', name: 'deploy' }),
    result(1, 1_110),
  ])
  assert.deepEqual(Object.keys(folded).sort(), ['countdowns', 'counters', 'cron', 'lastInjectionAt', 'lastMessageAt', 'lastTurnInjectionAt', 'mode', 'pending'])
})

test('a countdown notice marks the countdown fired and never dates the reading baselines', () => {
  const state = fold([
    call(1, 1_000, 'time_countdown', { action: 'start', name: 'build', in: '1m' }),
    result(1, 1_010),
    fireNotice(61_000, 'build'),
  ])
  assert.equal(state.countdowns[0]?.firedAt, 61_000)
  // The invariant that keeps a firing countdown from resetting the cron cadence:
  assert.equal(state.lastInjectionAt, null)
  assert.equal(state.lastTurnInjectionAt, null)
})

test('a countdown start commits relative to the instant its call was logged', () => {
  const state = fold([
    call(1, 1_000, 'time_countdown', { action: 'start', name: 'build', in: '10m' }),
    result(1, 1_010),
  ])
  assert.equal(state.countdowns.length, 1)
  // The baseline is the call's own instant, not the result's: the two paths (live
  // tool and log fold) must agree, and only the call instant is in the log.
  assert.equal(state.countdowns[0]?.firesAt, 601_000)
  assert.equal(state.countdowns[0]?.setAt, 1_000)
  assert.equal(state.countdowns[0]?.onFire, 'wake', 'waking is the default')
  assert.equal(state.countdowns[0]?.firedAt, undefined)
})

test('a countdown commits only once its result reports success', () => {
  const pending = fold([call(1, 1_000, 'time_countdown', { action: 'start', name: 'build', in: '10m' })])
  assert.deepEqual(pending.countdowns, [])
  assert.equal(pending.pending.length, 1)
  assert.equal(applySessionEvent(pending, result(1, 1_010), ZONE).countdowns.length, 1)
  const failed = fold([
    call(1, 1_000, 'time_countdown', { action: 'start', name: 'build', in: '10m' }),
    result(1, 1_010, true),
  ])
  assert.deepEqual(failed.countdowns, [])
})

test('a clock-time countdown resolves through the configured zone', () => {
  // 2026-10-11T00:00:00Z is 08:00 in Shanghai, so 15:30 there is 07:30Z the same day.
  const start = Date.parse('2026-10-11T00:00:00Z')
  const state = fold([
    call(1, start, 'time_countdown', { action: 'start', name: 'standup', at: '15:30', onFire: 'inject' }),
    result(1, start + 10),
  ])
  assert.equal(new Date(state.countdowns[0]!.firesAt).toISOString(), '2026-10-11T07:30:00.000Z')
  assert.equal(state.countdowns[0]?.onFire, 'inject')
})

test('snooze moves a fired countdown and clears its fire mark; cancel removes it', () => {
  const fired = fold([
    call(1, 1_000, 'time_countdown', { action: 'start', name: 'build', in: '10m' }),
    result(1, 1_010),
    fireNotice(601_000, 'build'),
  ])
  assert.equal(fired.countdowns[0]?.firedAt, 601_000)
  const snoozed = fold([
    call(2, 700_000, 'time_countdown', { action: 'snooze', name: 'build', in: '5m' }),
    result(2, 700_010),
  ], fired)
  assert.equal(snoozed.countdowns[0]?.firesAt, 1_000_000)
  assert.equal(snoozed.countdowns[0]?.firedAt, undefined, 'a snoozed countdown is pending again')
  const cancelled = fold([
    call(3, 800_000, 'time_countdown', { action: 'cancel', name: 'build' }),
    result(3, 800_010),
  ], snoozed)
  assert.deepEqual(cancelled.countdowns, [])
})

test('a countdown action with unusable arguments is dropped instead of throwing', () => {
  const state = fold([
    call(1, 1_000, 'time_countdown', { action: 'start', name: 'no-time' }),
    result(1, 1_010),
    call(2, 2_000, 'time_countdown', { action: 'start', name: 'both', in: '1m', at: '10:00' }),
    result(2, 2_010),
    call(3, 3_000, 'time_countdown', { action: 'snooze', name: 'no-time' }),
    result(3, 3_010),
    call(4, 4_000, 'time_countdown', { action: 'cancel', name: 'ghost' }),
    result(4, 4_010),
    call(5, 5_000, 'time_countdown', { action: 'start', name: 'loud', in: '1m', onFire: 'shout' }),
    result(5, 5_010),
    call(6, 6_000, 'time_countdown', { action: 'nonsense', name: 'x' }),
    result(6, 6_010),
  ])
  assert.deepEqual(state.countdowns, [])
})

test('a counter notice pushed from a related session is not a reading', () => {
  // The notice carries the same source kind but the `relay` form, so it must not
  // date `lastInjectionAt`: otherwise a notice would skew cron due-ness and the
  // turn cadence of the Session that received it.
  const state = fold([{
    type: 'user/message',
    time: 7_000,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>[counters] "x" was created…</system-reminder>' }],
      source: { kind: 'dsh-time-reminder', form: 'relay', senderSessionId: 'session-other' },
    },
  }])
  assert.equal(state.lastInjectionAt, null)
  assert.equal(state.lastTurnInjectionAt, null)
  assert.equal(state.lastMessageAt, null)
})

test('every mutating counter action reports what to announce', () => {
  const args = (action: string, extra: Record<string, unknown> = {}) => ({ action, name: 'deploy', ...extra })
  const empty = fresh()

  const created = counterChange(empty, args('start', { note: '开始', inject: true }), 1_000)
  assert.equal(created.announced?.kind, 'created')
  assert.equal(created.announced?.counter.startedAt, 1_000)
  assert.equal(created.announced?.previous, undefined)

  const restarted = counterChange(created.state, args('start'), 2_000)
  assert.equal(restarted.announced?.kind, 'restarted')
  assert.equal(restarted.announced?.previous?.startedAt, 1_000)
  assert.equal(restarted.announced?.counter.note, undefined, 'a restart replaces the label')

  const reset = counterChange(created.state, args('reset'), 2_000)
  assert.equal(reset.announced?.kind, 'reset')
  assert.equal(reset.announced?.counter.startedAt, 2_000)
  assert.equal(reset.announced?.counter.note, '开始', 'a reset keeps the label')

  const relabelled = counterChange(created.state, args('note', { note: '发布' }), 2_000)
  assert.equal(relabelled.announced?.kind, 'relabelled')
  assert.equal(relabelled.announced?.counter.note, '发布')

  const visibility = counterChange(created.state, args('scope', { toParents: true, depth: 1 }), 2_000)
  assert.equal(visibility.announced?.kind, 'visibility')
  assert.deepEqual(visibility.announced?.counter.scope, { ...DEFAULT_COUNTER_SCOPE, toParents: true, depth: 1 })
  assert.deepEqual(visibility.announced?.previous?.scope, DEFAULT_COUNTER_SCOPE, 'the old scope travels with the notice')

  const removed = counterChange(created.state, args('remove'), 2_000)
  assert.equal(removed.announced?.kind, 'removed')
  assert.equal(removed.announced?.counter.name, 'deploy')
})

test('read-only counter actions announce nothing', () => {
  const state = counterChange(fresh(), { action: 'start', name: 'deploy' }, 1_000).state
  assert.equal(counterChange(state, { action: 'lapse', name: 'deploy' }, 2_000).announced, undefined)
  assert.equal(counterChange(state, { action: 'list' }, 2_000).announced, undefined)
})
