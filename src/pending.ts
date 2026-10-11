/**
 * The durable pending-countdown table: a tiny index of which Sessions still owe a
 * countdown, so a restarted host knows where to look.
 *
 * The Session log stays authoritative. This table answers exactly one question —
 * "which Sessions have a countdown that has not fired yet" — because a plugin
 * cannot ask that of the Host: `ctx.sessions.list()` returns live Sessions only,
 * `ctx.sessions.get()` does not resume, and no API enumerates stored Sessions. A
 * row is therefore a *hint*: the startup reconcile resumes its Session, folds the
 * log, and believes the fold — a row whose countdown vanished, fired, or moved is
 * dropped then, so a stale or hand-edited row can never invent a reminder.
 *
 * Rows are written when a countdown commits and removed once one fires, which keeps
 * the table proportional to what is actually pending (usually nothing).
 *
 * Decoding is hand-rolled rather than schema-driven so this module — like the fold —
 * stays free of dependencies and directly testable; every malformed row is dropped
 * instead of throwing, because the file is data.
 *
 * @module dsh-time-reminder/pending
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CountdownOnFire } from './types.ts'

/** Table format version; a row set written by another version is ignored. */
const TABLE_VERSION = 1

/** One Session's pending countdown, as the table records it. */
export interface PendingRow {
  readonly sessionId: string
  readonly name: string
  readonly firesAt: number
  readonly onFire: CountdownOnFire
  readonly note?: string
  /** Instant this row was written; diagnostics only. */
  readonly wroteAt: number
}

/** Encode the table for durable storage. */
export function encodeTable(rows: readonly PendingRow[]): string {
  return `${JSON.stringify({ version: TABLE_VERSION, rows }, null, 2)}\n`
}

/**
 * Decode a table, dropping anything malformed.
 *
 * @param text - the stored document.
 * @returns the rows that decode; an unreadable document yields none.
 */
export function decodeTable(text: string): PendingRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const document = asRecord(parsed)
  if (document?.version !== TABLE_VERSION || !Array.isArray(document.rows)) return []
  const rows: PendingRow[] = []
  for (const candidate of document.rows) rows.push(...decodeRow(candidate))
  return rows
}

/** Decode one row, or nothing when it is not a row this version understands. */
function decodeRow(value: unknown): PendingRow[] {
  const row = asRecord(value)
  if (row === undefined) return []
  const { sessionId, name, firesAt, onFire, note, wroteAt } = row
  if (typeof sessionId !== 'string' || sessionId.length === 0) return []
  if (typeof name !== 'string' || name.length === 0) return []
  if (!Number.isSafeInteger(firesAt) || !Number.isSafeInteger(wroteAt)) return []
  if (onFire !== 'wake' && onFire !== 'inject') return []
  if (note !== undefined && typeof note !== 'string') return []
  return [{
    sessionId,
    name,
    firesAt: firesAt as number,
    onFire,
    ...note === undefined ? {} : { note },
    wroteAt: wroteAt as number,
  }]
}

/** Narrow an unknown value to a plain object without casting. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Replace one Session's row of that name, or append it. Pure. */
export function upsertRow(rows: readonly PendingRow[], row: PendingRow): readonly PendingRow[] {
  const index = rows.findIndex((candidate) => candidate.sessionId === row.sessionId && candidate.name === row.name)
  return index < 0 ? [...rows, row] : rows.map((candidate, at) => (at === index ? row : candidate))
}

/** Drop one row. Pure; returns the same reference when absent. */
export function removeRow(rows: readonly PendingRow[], sessionId: string, name: string): readonly PendingRow[] {
  const kept = rows.filter((row) => !(row.sessionId === sessionId && row.name === name))
  return kept.length === rows.length ? rows : kept
}

/** Every row of one Session, in table order. */
export function rowsForSession(rows: readonly PendingRow[], sessionId: string): PendingRow[] {
  return rows.filter((row) => row.sessionId === sessionId)
}

/** Where the table lives: a durable document the plugin reads once per start. */
export interface PendingStore {
  read(): Promise<PendingRow[]>
  write(rows: readonly PendingRow[]): Promise<void>
}

/**
 * A table backed by one JSON file.
 *
 * Writes go through a temporary sibling and a rename, so a crash mid-write leaves
 * the previous table intact instead of a half-written index.
 *
 * @param path - absolute path of the document.
 * @returns the file-backed store.
 */
export function fileStore(path: string): PendingStore {
  return {
    async read() {
      try {
        return decodeTable(await readFile(path, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    async write(rows) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, encodeTable(rows), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

/**
 * A table that lives only in memory.
 * @param initial - rows to start from.
 * @returns the in-memory store.
 */
export function memoryStore(initial: readonly PendingRow[] = []): PendingStore {
  let rows: PendingRow[] = [...initial]
  return {
    read: async () => rows,
    write: async (next) => { rows = [...next] },
  }
}
