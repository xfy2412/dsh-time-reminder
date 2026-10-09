/**
 * Lineage-based counter visibility, and the push targets derived from it.
 *
 * The three-generation fixture is `root → middle → leaf`, plus an unrelated
 * `other`. `read(sessionId)` always supplies that Session's own state, so a test
 * can never disagree with itself about what a Session holds.
 *
 * The scope flags are named from the owning Session's point of view:
 * `toChildren` exposes a counter to Sessions delegated from the owner,
 * `toParents` exposes it to the owner's ancestors. The default scope
 * (`toChildren: true`, `toParents: false`) therefore reaches two generations
 * downward and never upward.
 *
 * @module dsh-time-reminder/tests/visibility.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushTargets, visibleCounters, type SessionFacts } from '../src/visibility.ts'
import { DEFAULT_COUNTER_SCOPE, type CounterRecord, type TimeReminderState } from '../src/types.ts'

/** Build one counter with scope overrides. */
const counter = (name: string, startedAt = 1_000, scope: Partial<CounterRecord['scope']> = {}): CounterRecord => ({
  name,
  startedAt,
  inject: false,
  scope: { ...DEFAULT_COUNTER_SCOPE, ...scope },
})

/** Build a state carrying the given counters. */
const state = (...counters: CounterRecord[]): TimeReminderState => ({
  mode: 'cron',
  cron: '0 0 * * *',
  lastInjectionAt: null,
  lastTurnInjectionAt: null,
  lastMessageAt: null,
  counters,
  pending: [],
})

const ROOT: SessionFacts = { id: 'root', parentSession: undefined }
const MIDDLE: SessionFacts = { id: 'middle', parentSession: 'root' }
const LEAF: SessionFacts = { id: 'leaf', parentSession: 'middle' }
const OTHER: SessionFacts = { id: 'other', parentSession: undefined }
const ALL = [ROOT, MIDDLE, LEAF, OTHER]

/** Build the reader for one fixture of Session states. */
function fixture(states: Record<string, TimeReminderState>) {
  const source = { list: (): readonly SessionFacts[] => ALL }
  const stateOf = (id: string): TimeReminderState | undefined => states[id]
  return {
    /** Counters one Session sees, as `[name, origin, distance]` triples. */
    seenBy: (session: SessionFacts): [string, string, number][] =>
      visibleCounters(session, states[session.id] ?? state(), source, stateOf)
        .map((entry) => [entry.counter.name, entry.origin, entry.distance]),
    /** Full resolved entries, when a test needs more than the triple. */
    resolvedFor: (session: SessionFacts) =>
      visibleCounters(session, states[session.id] ?? state(), source, stateOf),
    /** Sessions one counter reaches, as `[id, direction, distance]` triples. */
    targetsFor: (owner: SessionFacts, counter_: CounterRecord): [string, string, number][] =>
      pushTargets(owner, counter_, source).map((target) => [target.id, target.direction, target.distance]),
  }
}

test('a session always sees its own counters', () => {
  const { seenBy } = fixture({ root: state(counter('own')) })
  assert.deepEqual(seenBy(ROOT), [['own', 'own', 0]])
})

test('the default scope reaches two generations downward', () => {
  const { seenBy } = fixture({ root: state(counter('shared')), middle: state(), leaf: state() })
  assert.deepEqual(seenBy(MIDDLE), [['shared', 'ancestor', 1]])
  assert.deepEqual(seenBy(LEAF), [['shared', 'ancestor', 2]], 'depth 2 spans the grandchild too')
})

test('the default scope never reaches upward', () => {
  const { seenBy } = fixture({ root: state(), middle: state(counter('fromChild')), leaf: state() })
  assert.deepEqual(seenBy(ROOT), [], 'toParents defaults to false, so an ancestor stays blind')
  assert.deepEqual(seenBy(MIDDLE), [['fromChild', 'own', 0]])
})

test('toChildren false hides a counter from the whole subtree', () => {
  const { seenBy } = fixture({
    root: state(counter('private', 1_000, { toChildren: false })),
    middle: state(),
    leaf: state(),
  })
  assert.deepEqual(seenBy(MIDDLE), [])
  assert.deepEqual(seenBy(LEAF), [])
})

test('depth stops the downward walk one level short', () => {
  const { seenBy } = fixture({
    root: state(counter('oneLevel', 1_000, { depth: 1 })),
    middle: state(),
    leaf: state(),
  })
  assert.deepEqual(seenBy(MIDDLE), [['oneLevel', 'ancestor', 1]])
  assert.deepEqual(seenBy(LEAF), [], 'two levels away exceeds depth 1')
})

test('toParents exposes a descendant counter to its ancestors within depth', () => {
  const { seenBy } = fixture({
    root: state(),
    middle: state(),
    leaf: state(counter('up', 1_000, { toParents: true, depth: 2 })),
  })
  assert.deepEqual(seenBy(MIDDLE), [['up', 'descendant', 1]])
  assert.deepEqual(seenBy(ROOT), [['up', 'descendant', 2]])
})

test('an unrelated session sees nothing from the lineage', () => {
  const { seenBy } = fixture({
    root: state(counter('shared')),
    middle: state(),
    leaf: state(counter('leafOnly', 1_000, { toParents: true, depth: 2 })),
    other: state(),
  })
  assert.deepEqual(seenBy(OTHER), [])
})

test('a session-local counter is never reported as inherited', () => {
  const { seenBy } = fixture({
    root: state(counter('sameName', 1_000, { depth: 2 })),
    middle: state(counter('sameName', 5_000, { depth: 2 })),
    leaf: state(),
  })
  assert.deepEqual(seenBy(MIDDLE), [['sameName', 'own', 0]])
})

test('an own counter shadows an inherited one with the same name', () => {
  const { resolvedFor } = fixture({
    root: state(counter('deploy', 1_000, { depth: 2 })),
    middle: state(),
    leaf: state(counter('deploy', 9_999)),
  })
  const visible = resolvedFor(LEAF)
  assert.equal(visible.length, 1)
  assert.equal(visible[0]!.origin, 'own')
  assert.equal(visible[0]!.counter.startedAt, 9_999)
})

test('nearest relation wins among inherited counters with the same name', () => {
  const { resolvedFor } = fixture({
    root: state(counter('shared', 1, { depth: 2 })),
    middle: state(counter('shared', 2, { toParents: true, depth: 2 })),
    leaf: state(),
  })
  const visible = resolvedFor(LEAF)
  assert.equal(visible.length, 1)
  assert.equal(visible[0]!.distance, 1, 'the closer ancestor provides it')
  assert.equal(visible[0]!.counter.startedAt, 2)
})

test('an unknown ancestor id stops the walk without throwing', () => {
  const orphan: SessionFacts = { id: 'orphan', parentSession: 'gone' }
  const { seenBy } = fixture({})
  assert.deepEqual(seenBy(orphan), [])
})

test('results are ordered nearest first, then by name', () => {
  const { seenBy } = fixture({
    root: state(counter('zulu', 1_000, { depth: 2 }), counter('alpha', 1_000, { depth: 2 })),
    middle: state(counter('middle', 1_000, { toParents: true, depth: 1 })),
    leaf: state(),
  })
  assert.deepEqual(seenBy(LEAF).map((entry) => entry[0]), ['middle', 'alpha', 'zulu'])
})

test('push targets mirror the downward scope', () => {
  const { targetsFor } = fixture({})
  assert.deepEqual(targetsFor(ROOT, counter('down')), [['middle', 'descendant', 1], ['leaf', 'descendant', 2]])
})

test('push targets mirror the upward scope', () => {
  const { targetsFor } = fixture({})
  assert.deepEqual(
    targetsFor(LEAF, counter('up', 1_000, { toChildren: false, toParents: true })),
    [['middle', 'ancestor', 1], ['root', 'ancestor', 2]],
  )
})

test('push targets honour depth in both directions', () => {
  const { targetsFor } = fixture({})
  assert.deepEqual(targetsFor(ROOT, counter('one', 1_000, { depth: 1 })), [['middle', 'descendant', 1]])
  assert.deepEqual(
    targetsFor(LEAF, counter('one', 1_000, { toChildren: false, toParents: true, depth: 1 })),
    [['middle', 'ancestor', 1]],
  )
})

test('push targets skip the unrelated session and report an unknown ancestor', () => {
  const { targetsFor } = fixture({})
  assert.deepEqual(targetsFor(OTHER, counter('down')), [])
  const orphan: SessionFacts = { id: 'orphan', parentSession: 'gone' }
  assert.deepEqual(targetsFor(orphan, counter('up', 1_000, { toParents: true, depth: 2 })), [['gone', 'ancestor', 1]])
})
