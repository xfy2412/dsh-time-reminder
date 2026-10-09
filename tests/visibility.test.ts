/**
 * Lineage-based counter visibility.
 *
 * The three-generation fixture is `root → middle → leaf`, plus an unrelated
 * `other`. `read(sessionId)` always supplies that Session's own state, so a test
 * can never disagree with itself about what a Session holds.
 *
 * @module dsh-time-reminder/tests/visibility.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleCounters, type SessionFacts } from '../src/visibility.ts'
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
  lastInjectionAt: null,
  lastTurnInjectionAt: null,
  lastMessageAt: null,
  counters,
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
  }
}

test('a session always sees its own counters', () => {
  const { seenBy } = fixture({ root: state(counter('own')) })
  assert.deepEqual(seenBy(ROOT), [['own', 'own', 0]])
})

test('toParents is off by default, so an ancestor stays invisible', () => {
  const { seenBy } = fixture({ root: state(counter('hidden')), middle: state() })
  assert.deepEqual(seenBy(MIDDLE), [], 'the child does not see the parent counter')
})

test('toParents exposes a counter to descendants within depth', () => {
  const { seenBy } = fixture({
    root: state(counter('shared', 1_000, { toParents: true, depth: 2 })),
    middle: state(),
    leaf: state(),
  })
  assert.deepEqual(seenBy(MIDDLE), [['shared', 'ancestor', 1]])
  assert.deepEqual(seenBy(LEAF), [['shared', 'ancestor', 2]])
})

test('depth stops the walk one level short', () => {
  const { seenBy } = fixture({
    root: state(counter('oneLevel', 1_000, { toParents: true, depth: 1 })),
    middle: state(),
    leaf: state(),
  })
  assert.equal(seenBy(MIDDLE).length, 1)
  assert.deepEqual(seenBy(LEAF), [], 'two levels away exceeds depth 1')
})

test('toChildren exposes a counter downward, and never to an unrelated session', () => {
  const { seenBy, resolvedFor } = fixture({
    root: state(counter('down', 1_000, { toChildren: true, depth: 2 })),
    middle: state(),
    leaf: state(),
    other: state(),
  })
  // ROOT owns `down`, so for ROOT itself it is `own`; the downward exposure is what
  // makes it show up in MIDDLE and LEAF at all.
  assert.deepEqual(seenBy(ROOT), [['down', 'own', 0]])
  assert.deepEqual(seenBy(MIDDLE), [], 'a child does not see a parent counter without toParents')
  assert.deepEqual(seenBy(OTHER), [], 'an unrelated session sees nothing')
  // Reading from ROOT while the counter lives elsewhere is the case toChildren serves.
  const fromRoot = resolvedFor(ROOT)
  assert.equal(fromRoot.length, 1)
  assert.equal(fromRoot[0]!.origin, 'own', 'the owner keeps its own entry, not a descendant duplicate')
})

test('toChildren is on by default', () => {
  const { seenBy } = fixture({
    root: state(counter('down', 1_000, { toChildren: true, depth: 2 })),
    middle: state(),
    leaf: state(),
  })
  // `down` lives on ROOT; a default-scoped counter on ROOT must not reach up.
  assert.deepEqual(seenBy(LEAF), [], 'default scope never exposes upward')
  const defaulted = fixture({ middle: state(counter('fromMiddle')), leaf: state() })
  assert.deepEqual(defaulted.seenBy(LEAF), [], 'leaf does not see a parent counter by default')
})

test('a descendant counter is visible from its ancestor when it opts in', () => {
  // The holder is the descendant, the reader is the ancestor: this is the direction
  // `toChildren` names, and the only shape that can report `origin: descendant`.
  const { seenBy } = fixture({
    root: state(),
    middle: state(),
    leaf: state(counter('fromLeaf', 1_000, { toChildren: true, depth: 2 })),
  })
  assert.deepEqual(seenBy(MIDDLE), [['fromLeaf', 'descendant', 1]])
  assert.deepEqual(seenBy(ROOT), [['fromLeaf', 'descendant', 2]])
})

test('a session-local counter is never reported as inherited', () => {
  const { seenBy } = fixture({
    root: state(counter('rootOnly', 1_000, { toParents: true, depth: 2 })),
    middle: state(counter('rootOnly', 5_000, { toChildren: true, depth: 2 })),
    leaf: state(),
  })
  // MIDDLE holds its own `rootOnly`, so ROOT's same-named counter never surfaces here.
  assert.deepEqual(seenBy(MIDDLE), [['rootOnly', 'own', 0]])
})

test('a own counter shadows an inherited one with the same name', () => {
  const { resolvedFor } = fixture({
    root: state(counter('deploy', 1_000, { toParents: true, depth: 2 })),
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
    root: state(counter('shared', 1, { toParents: true, depth: 2 })),
    middle: state(counter('shared', 2, { toParents: true, depth: 1 })),
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
    root: state(counter('zulu', 1_000, { toParents: true, depth: 2 }), counter('alpha', 1_000, { toParents: true, depth: 2 })),
    middle: state(counter('middle', 1_000, { toParents: true, depth: 1 })),
    leaf: state(),
  })
  assert.deepEqual(seenBy(LEAF).map((entry) => entry[0]), ['middle', 'alpha', 'zulu'])
})
