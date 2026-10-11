/**
 * Unit tests for the pure countdown arithmetic.
 *
 * They pin the two things a countdown can get wrong without anyone noticing:
 * how a spelling maps to an instant, and how "the same" instant stays the same
 * when the live tool and the log fold resolve it on different days.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LISTED_FIRED_LIMIT,
  MAX_TIMER_DELAY_MS,
  describeRemaining,
  formatClockTime,
  listedCountdowns,
  nextClockInstant,
  parseClockTime,
  parseDuration,
  resolveFiresAt,
} from '../src/countdown.ts'
import type { CountdownRecord } from '../src/types.ts'

const SHANGHAI = 'Asia/Shanghai'

test('parseDuration accepts single units and compounds', () => {
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('5m'), 300_000)
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('2d'), 172_800_000)
  assert.equal(parseDuration(' 10m '), 600_000)
})

test('parseDuration rejects anything that is not <number><unit> tokens', () => {
  for (const bad of ['', 'm', '10', '10 minutes', '1m30', '-5m', '5m!', '1.5h', 'm5']) {
    assert.throws(() => parseDuration(bad), TypeError, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('parseClockTime accepts H:MM and HH:MM, and rejects the rest', () => {
  assert.deepEqual(parseClockTime('15:30'), { hour: 15, minute: 30 })
  assert.deepEqual(parseClockTime('9:05'), { hour: 9, minute: 5 })
  assert.equal(formatClockTime(parseClockTime('9:05')), '09:05')
  for (const bad of ['24:00', '15:60', '1530', '15:3', '', 'noon']) {
    assert.throws(() => parseClockTime(bad), TypeError, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('nextClockInstant resolves in the requested zone, not the process zone', () => {
  // 2026-10-11T00:00:00Z is 08:00 in Shanghai, so the next 15:30 there is the same day.
  const now = Date.parse('2026-10-11T00:00:00Z')
  const at = nextClockInstant({ hour: 15, minute: 30 }, SHANGHAI, now)
  assert.equal(new Date(at).toISOString(), '2026-10-11T07:30:00.000Z')
})

test('nextClockInstant rolls to tomorrow once today\'s time has passed', () => {
  const now = Date.parse('2026-10-11T09:00:00Z') // 17:00 in Shanghai
  const at = nextClockInstant({ hour: 15, minute: 30 }, SHANGHAI, now)
  assert.equal(new Date(at).toISOString(), '2026-10-12T07:30:00.000Z')
})

test('nextClockInstant is strictly in the future', () => {
  const exact = Date.parse('2026-10-11T07:30:00.000Z') // exactly 15:30 Shanghai
  const at = nextClockInstant({ hour: 15, minute: 30 }, SHANGHAI, exact)
  assert.ok(at > exact, 'an instant equal to now must not be returned')
  assert.equal(new Date(at).toISOString(), '2026-10-12T07:30:00.000Z')
})

test('resolveFiresAt needs exactly one of in/at', () => {
  const now = Date.parse('2026-10-11T00:00:00Z')
  assert.equal(resolveFiresAt({ in: '10m' }, now, SHANGHAI), now + 600_000)
  assert.throws(() => resolveFiresAt({}, now, SHANGHAI), TypeError)
  assert.throws(() => resolveFiresAt({ in: '10m', at: '15:30' }, now, SHANGHAI), TypeError)
  assert.throws(() => resolveFiresAt({ in: '  ' }, now, SHANGHAI), TypeError)
})

test('describeRemaining reads as pending, due, then overdue', () => {
  assert.equal(describeRemaining(1_000 + 90_000, 1_000), 'in 1m30s')
  assert.equal(describeRemaining(1_000, 1_000), 'due now')
  assert.equal(describeRemaining(1_000, 61_000), 'overdue by 1m0s')
})

test('a day-long countdown still fits one timer', () => {
  assert.ok(parseDuration('1d') < MAX_TIMER_DELAY_MS)
})

/** One countdown record for the listing tests. */
const record = (over: Partial<CountdownRecord> = {}): CountdownRecord => ({
  name: 'build',
  firesAt: 1_000,
  setAt: 900,
  onFire: 'wake',
  ...over,
})

test('listing hides fired countdowns unless they are asked for', () => {
  const pending = record({ name: 'pending' })
  const fired = record({ name: 'fired', firedAt: 1_500 })
  assert.deepEqual(listedCountdowns([fired, pending], false), [pending], 'history stays out of the default view')
  assert.deepEqual(
    listedCountdowns([fired, pending], true).map((entry) => entry.name),
    ['pending', 'fired'],
    'asked-for history comes after what is still owed',
  )
})

test('asked-for history is newest first and capped', () => {
  const fired = Array.from({ length: LISTED_FIRED_LIMIT + 4 }, (_unused, index) =>
    record({ name: `fired-${index}`, firesAt: 1_000 + index, firedAt: 2_000 + index }))
  const listed = listedCountdowns(fired, true)
  assert.equal(listed.length, LISTED_FIRED_LIMIT)
  assert.equal(listed[0]?.name, `fired-${LISTED_FIRED_LIMIT + 3}`, 'the most recent one leads')
})
