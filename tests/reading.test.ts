/**
 * Reading rendering: timestamps, durations, and the mode lines.
 *
 * @module dsh-time-reminder/tests/reading.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalTimeZone, cronDue, formatDuration, formatTimestamp, renderReading } from '../src/reading.ts'
import { parseCron } from '../src/cron.ts'

const ZONE = 'Asia/Shanghai'
const DAILY = parseCron('0 0 * * *')

test('formatTimestamp carries the numeric offset and the IANA zone', () => {
  // 2026-10-09T01:23:45+08:00
  assert.equal(formatTimestamp(Date.parse('2026-10-08T17:23:45Z'), ZONE), '2026-10-09T01:23:45+08:00[Asia/Shanghai]')
})

test('formatTimestamp renders UTC as +00:00 rather than GMT', () => {
  assert.equal(formatTimestamp(Date.parse('2026-10-09T00:00:00Z'), 'UTC'), '2026-10-09T00:00:00+00:00[UTC]')
})

test('canonicalTimeZone rejects spellings Intl would rewrite', () => {
  assert.equal(canonicalTimeZone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.throws(() => canonicalTimeZone('asia/shanghai'), /must be canonical/)
  assert.throws(() => canonicalTimeZone('Not/AZone'), /Invalid time zone|must be canonical/)
})

test('formatDuration stays compact across magnitudes', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(999), '1s')
  assert.equal(formatDuration(59_400), '59s')
  assert.equal(formatDuration(60_000), '1m0s')
  assert.equal(formatDuration(3_661_000), '1h1m')
  assert.equal(formatDuration(90_000_000), '1d1h')
  assert.equal(formatDuration(-5000), '0s', 'a backwards clock never renders negative')
})

test('cronDue is always true without a baseline', () => {
  const now = Date.parse('2026-10-09T05:00:00+08:00')
  assert.equal(cronDue(DAILY, ZONE, undefined, now), true)
})

test('cronDue fires only after the schedule is crossed', () => {
  const now = Date.parse('2026-10-09T05:00:00+08:00')
  const beforeMidnight = Date.parse('2026-10-08T23:00:00+08:00')
  const afterMidnight = Date.parse('2026-10-09T00:10:00+08:00')
  assert.equal(cronDue(DAILY, ZONE, beforeMidnight, now), true, 'midnight was crossed')
  assert.equal(cronDue(DAILY, ZONE, afterMidnight, now), false, 'midnight is behind us')
})

test('renderReading produces the first-step shape with a counter line', () => {
  const text = renderReading({
    now: Date.parse('2026-10-09T01:23:45+08:00'),
    turn: 12,
    step: 1,
    zone: ZONE,
    mode: 'cron',
    cron: DAILY,
    fresh: true,
    sinceMessageMs: 187_000,
    lastInjectionAt: Date.parse('2026-10-08T00:00:03+08:00'),
    counters: [{ name: 'deploy', elapsedMs: 1_243_000, note: '开始部署' }],
  })
  assert.equal(text, [
    'Time sampled while preparing turn 12, step 1: 2026-10-09T01:23:45+08:00[Asia/Shanghai]',
    'Time mode: cron (daily 00:00 Asia/Shanghai; previous reading 2026-10-08T00:00:03+08:00[Asia/Shanghai])',
    'Elapsed since the preceding model-visible message: 3m7s',
    '[counters] deploy=20m43s (开始部署)',
  ].join('\n'))
})

test('renderReading switches the baseline on later steps', () => {
  const text = renderReading({
    now: Date.parse('2026-10-09T01:24:00+08:00'),
    turn: 12,
    step: 3,
    zone: ZONE,
    mode: 'fine',
    cron: DAILY,
    fresh: false,
    sinceReadingMs: 15_000,
    counters: [],
  })
  assert.equal(text, [
    'Time sampled while preparing turn 12, step 3: 2026-10-09T01:24:00+08:00[Asia/Shanghai]',
    'Time mode: fine (a reading accompanies every step; zone Asia/Shanghai)',
    'Elapsed since the preceding step context: 15s',
  ].join('\n'))
})

test('renderReading renders turn mode with the previous-turn gap on any step', () => {
  // `turn` injects only at a turn's first step, but the renderer must not assume it:
  // it always reports the gap to the preceding model-visible message.
  const text = renderReading({
    now: Date.parse('2026-10-09T09:00:00+08:00'),
    turn: 20,
    step: 1,
    zone: ZONE,
    mode: 'turn',
    cron: DAILY,
    fresh: true,
    sinceLastMessageMs: 7_200_000,
    counters: [],
  })
  assert.equal(text, [
    'Time sampled while preparing turn 20, step 1: 2026-10-09T09:00:00+08:00[Asia/Shanghai]',
    'Time mode: turn (one reading at the first step of every turn)',
    'Elapsed since the preceding model-visible message: 2h0m',
  ].join('\n'))
})

test('renderReading reports turn mode without a baseline as unavailable', () => {
  const text = renderReading({
    now: Date.parse('2026-10-09T09:00:00+08:00'),
    turn: 1,
    step: 1,
    zone: ZONE,
    mode: 'turn',
    cron: DAILY,
    fresh: true,
    counters: [],
  })
  assert.match(text, /preceding model-visible message: unavailable/)
})

test('renderReading reports an unavailable baseline instead of guessing', () => {
  const text = renderReading({
    now: Date.parse('2026-10-09T01:24:00+08:00'),
    turn: 1,
    step: 1,
    zone: ZONE,
    mode: 'cron',
    cron: DAILY,
    fresh: true,
    counters: [],
  })
  assert.match(text, /preceding model-visible message: unavailable/)
  assert.match(text, /previous reading no earlier reading/)
})
