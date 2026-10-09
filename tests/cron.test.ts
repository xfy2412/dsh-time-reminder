/**
 * Cron parsing and occurrence resolution.
 *
 * @module dsh-time-reminder/tests/cron.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeCron, latestOccurrence, parseCron } from '../src/cron.ts'

const ZONE = 'Asia/Shanghai'

/** Epoch milliseconds for one instant written in the display zone (+08:00). */
const at = (iso: string): number => Date.parse(`${iso}+08:00`)

test('parseCron accepts the default daily schedule', () => {
  const parsed = parseCron('0 0 * * *')
  assert.deepEqual(parsed.minutes, [0])
  assert.deepEqual(parsed.hours, [0])
  assert.deepEqual(parsed.daysOfMonth, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  assert.deepEqual(parsed.months, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.deepEqual(parsed.daysOfWeek, [0, 1, 2, 3, 4, 5, 6])
})

test('parseCron expands macros', () => {
  assert.equal(parseCron('@daily').text, '0 0 * * *')
  assert.equal(parseCron('@hourly').text, '0 * * * *')
  assert.equal(parseCron('@weekly').text, '0 0 * * 0')
  assert.equal(parseCron('@monthly').text, '0 0 1 * *')
})

test('parseCron handles ranges, steps, lists, and the Sunday alias', () => {
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45])
  assert.deepEqual(parseCron('0 9-17 * * 1-5').hours, [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual(parseCron('0 9-17 * * 1-5').daysOfWeek, [1, 2, 3, 4, 5])
  assert.deepEqual(parseCron('5,35 8 * * *').minutes, [5, 35])
  assert.deepEqual(parseCron('0 0 * * 7').daysOfWeek, [0], '7 is Sunday')
  assert.deepEqual(parseCron('0 0 * * 0,7').daysOfWeek, [0], 'both spellings collapse')
})

test('parseCron rejects malformed expressions', () => {
  assert.throws(() => parseCron(''), /must not be blank/)
  assert.throws(() => parseCron('0 0 * *'), /5 fields/)
  assert.throws(() => parseCron('60 0 * * *'), /out of range/)
  assert.throws(() => parseCron('0 24 * * *'), /out of range/)
  assert.throws(() => parseCron('0 0 0 * *'), /out of range/)
  assert.throws(() => parseCron('x 0 * * *'), /not a number/)
  assert.throws(() => parseCron('0 0 * * 1-'), /not a number/)
  assert.throws(() => parseCron('0 17-9 * * *'), /descending/)
  assert.throws(() => parseCron('*/0 * * * *'), /step must be a positive integer/)
})

test('latestOccurrence finds the crossed midnight and nothing before it', () => {
  const daily = parseCron('0 0 * * *')
  // 2026-10-09 01:00 +08:00 — today's 00:00 lies between the previous reading
  // (2026-10-08 12:00) and now.
  const now = at('2026-10-09T01:00:00')
  const since = at('2026-10-08T12:00:00')
  assert.equal(latestOccurrence(daily, since, now, ZONE), at('2026-10-09T00:00:00'))

  // A reading taken after midnight means today's occurrence is already behind us.
  const after = at('2026-10-09T00:30:00')
  assert.equal(latestOccurrence(daily, after, now, ZONE), undefined)
})

test('latestOccurrence reports the newest match when several were crossed', () => {
  const hourly = parseCron('0 * * * *')
  const now = at('2026-10-09T05:10:00')
  const since = at('2026-10-08T20:00:00')
  assert.equal(latestOccurrence(hourly, since, now, ZONE), at('2026-10-09T05:00:00'))
})

test('latestOccurrence honours day-of-week restrictions', () => {
  const weekly = parseCron('0 9 * * 1')
  // 2026-10-09 is a Friday; the preceding Monday is 2026-10-05.
  const now = at('2026-10-09T12:00:00')
  const since = at('2026-10-01T00:00:00')
  assert.equal(latestOccurrence(weekly, since, now, ZONE), at('2026-10-05T09:00:00'))
})

test('latestOccurrence resolves in the requested zone, not the process zone', () => {
  const daily = parseCron('0 0 * * *')
  const now = Date.parse('2026-10-08T17:00:00Z')   // 2026-10-09 01:00 +08:00, 18:00 in London
  const since = Date.parse('2026-10-08T00:00:00Z')
  assert.equal(latestOccurrence(daily, since, now, 'Asia/Shanghai'), Date.parse('2026-10-08T16:00:00Z'))
  assert.equal(latestOccurrence(daily, since, now, 'Europe/London'), Date.parse('2026-10-08T23:00:00Z') <= now ? Date.parse('2026-10-07T23:00:00Z') : undefined)
})

test('latestOccurrence returns undefined for an empty window', () => {
  const daily = parseCron('0 0 * * *')
  const now = at('2026-10-09T01:00:00')
  assert.equal(latestOccurrence(daily, now, now, ZONE), undefined)
  assert.equal(latestOccurrence(daily, now, now - 1, ZONE), undefined)
})

test('describeCron names the common schedules', () => {
  assert.equal(describeCron(parseCron('0 0 * * *'), ZONE), `daily 00:00 ${ZONE}`)
  assert.equal(describeCron(parseCron('0 * * * *'), ZONE), `hourly ${ZONE}`)
  assert.equal(describeCron(parseCron('30 8 * * 1-5'), ZONE), `30 8 * * 1-5 ${ZONE}`)
})
