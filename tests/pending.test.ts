/**
 * Unit tests for the pending-countdown table.
 *
 * The table only decides *where to look after a restart*, so the properties that
 * matter are: a well-formed document round-trips, anything malformed is dropped
 * rather than thrown, and the row helpers do not disturb unrelated Sessions.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeTable,
  encodeTable,
  fileStore,
  memoryStore,
  removeRow,
  rowsForSession,
  upsertRow,
  type PendingRow,
} from '../src/pending.ts'

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  sessionId: 'session-1',
  name: 'build',
  firesAt: 1_000,
  onFire: 'wake',
  wroteAt: 900,
  ...over,
})

test('a table round-trips through its encoding', () => {
  const rows = [row(), row({ sessionId: 'session-2', name: 'standup', onFire: 'inject', note: '看 CI' })]
  assert.deepEqual(decodeTable(encodeTable(rows)), rows)
})

test('decoding drops anything malformed instead of throwing', () => {
  assert.deepEqual(decodeTable('not json'), [])
  assert.deepEqual(decodeTable('{"version":2,"rows":[]}'), [], 'another version is not this table')
  assert.deepEqual(decodeTable('{"version":1,"rows":{}}'), [], 'rows must be an array')
  const good = row()
  const cases: unknown[] = [
    { ...good, sessionId: '' },
    { ...good, sessionId: 7 },
    { ...good, name: '' },
    { ...good, firesAt: 1.5 },
    { ...good, wroteAt: 'yesterday' },
    { ...good, onFire: 'shout' },
    { ...good, note: 3 },
    null,
    'row',
    [good],
  ]
  for (const bad of cases) {
    assert.deepEqual(decodeTable(JSON.stringify({ version: 1, rows: [bad] })), [], `expected ${JSON.stringify(bad)} to be dropped`)
  }
  // One bad row must not take the good ones with it.
  assert.deepEqual(decodeTable(JSON.stringify({ version: 1, rows: [good, { nope: true }] })), [good])
})

test('upsertRow replaces the same Session\u2019s row of that name and appends otherwise', () => {
  const first = row()
  const other = row({ sessionId: 'session-2' })
  const rows = upsertRow(upsertRow([], first), other)
  const moved = upsertRow(rows, row({ firesAt: 5_000 }))
  assert.deepEqual(moved, [row({ firesAt: 5_000 }), other], 'the same (session, name) is replaced in place')
  assert.equal(upsertRow([], row({ name: 'later' })).length, 1)
})

test('removeRow keeps the array identity when nothing matches', () => {
  const rows = [row(), row({ sessionId: 'session-2' })]
  assert.equal(removeRow(rows, 'session-1', 'ghost'), rows, 'an absent row must not reallocate')
  assert.deepEqual(removeRow(rows, 'session-1', 'build'), [row({ sessionId: 'session-2' })])
})

test('rowsForSession selects one Session\u2019s rows', () => {
  const rows = [row(), row({ name: 'other' }), row({ sessionId: 'session-2' })]
  assert.deepEqual(rowsForSession(rows, 'session-1').map((entry) => entry.name), ['build', 'other'])
})

test('the in-memory store round-trips rows', async () => {
  const store = memoryStore()
  assert.deepEqual(await store.read(), [])
  await store.write([row()])
  assert.deepEqual(await store.read(), [row()])
})

test('the file store persists across reads, tolerates a missing file, and survives a torn write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'time-reminder-table-'))
  const path = join(directory, 'nested', 'countdowns.json')
  try {
    const store = fileStore(path)
    assert.deepEqual(await store.read(), [], 'a missing file is an empty table, not an error')
    await store.write([row()])
    assert.deepEqual(await store.read(), [row()])
    // A crash between truncate and write leaves something unreadable; the table is
    // a hint, so an unreadable file degrades to "no rows" instead of failing startup.
    await writeFile(path, '{"version":1,"rows":[', 'utf8')
    assert.deepEqual(await store.read(), [])
    // The temporary sibling must not be left claiming to be the table.
    assert.match(await readFile(path, 'utf8'), /^\{"version":1,"rows":\[$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
