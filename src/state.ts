/**
 * The projection schema for this plugin's per-Session state.
 *
 * The state itself is folded from the Session log by `./fold.ts`; this module
 * only declares the schema DSH validates the folded state against. It is the one
 * place that imports `zod`, so the fold and its tests stay dependency-free.
 *
 * @module dsh-time-reminder/state
 */

import { z } from 'zod'

/** Zod schema for the folded per-Session state; the projection validates with it. */
export const timeReminderStateSchema = z.object({
  mode: z.union([z.literal('off'), z.literal('cron'), z.literal('turn'), z.literal('fine')]),
  cron: z.string(),
  lastInjectionAt: z.number().nullable(),
  lastTurnInjectionAt: z.number().nullable(),
  lastMessageAt: z.number().nullable(),
  counters: z.array(z.object({
    name: z.string(),
    startedAt: z.number(),
    note: z.string().optional(),
    inject: z.boolean(),
    scope: z.object({
      toChildren: z.boolean(),
      toParents: z.boolean(),
      depth: z.number(),
    }),
  })),
  pending: z.array(z.object({
    callId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
  })),
})
