import { z } from 'zod';

const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const IsoTimestampMs = z
  .string()
  .refine((s) => ISO_MS_UTC.test(s), { message: 'expected UTC ISO-8601 with millisecond precision, e.g. 2026-04-20T14:11:00.000Z' })
  .refine(
    (s) => {
      const t = Date.parse(s);
      return Number.isFinite(t);
    },
    { message: 'invalid calendar date' },
  );

export type IsoTimestampMs = z.infer<typeof IsoTimestampMs>;

export function normalizeTimestamp(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    throw new TypeError(`cannot normalize timestamp: ${String(input)}`);
  }
  return new Date(ms).toISOString();
}
