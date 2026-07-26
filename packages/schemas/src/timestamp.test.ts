import { describe, it, expect } from 'vitest';
import { IsoTimestampMs, normalizeTimestamp } from './timestamp.js';

describe('IsoTimestampMs', () => {
  it('accepts UTC ISO-8601 with millisecond precision', () => {
    expect(IsoTimestampMs.safeParse('2026-04-20T14:11:00.000Z').success).toBe(true);
    expect(IsoTimestampMs.safeParse('2026-04-20T14:11:00.123Z').success).toBe(true);
  });

  it('rejects timestamps without millisecond precision', () => {
    expect(IsoTimestampMs.safeParse('2026-04-20T14:11:00Z').success).toBe(false);
  });

  it('rejects non-UTC timezones', () => {
    expect(IsoTimestampMs.safeParse('2026-04-20T14:11:00.000+02:00').success).toBe(false);
    expect(IsoTimestampMs.safeParse('2026-04-20T14:11:00.000-05:00').success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(IsoTimestampMs.safeParse(1745154660000).success).toBe(false);
    expect(IsoTimestampMs.safeParse(null).success).toBe(false);
  });

  it('rejects structurally invalid timestamps', () => {
    expect(IsoTimestampMs.safeParse('not-a-date').success).toBe(false);
    expect(IsoTimestampMs.safeParse('2026-13-40T99:99:99.999Z').success).toBe(false);
  });
});

describe('normalizeTimestamp', () => {
  it('converts a Date to UTC ms ISO string', () => {
    const d = new Date(Date.UTC(2026, 3, 20, 14, 11, 0, 42));
    expect(normalizeTimestamp(d)).toBe('2026-04-20T14:11:00.042Z');
  });

  it('normalizes a second-precision string to ms precision', () => {
    expect(normalizeTimestamp('2026-04-20T14:11:00Z')).toBe('2026-04-20T14:11:00.000Z');
  });

  it('normalizes a tz-offset string to UTC', () => {
    expect(normalizeTimestamp('2026-04-20T16:11:00.000+02:00')).toBe('2026-04-20T14:11:00.000Z');
  });

  it('throws on unparseable input', () => {
    expect(() => normalizeTimestamp('not-a-date')).toThrow();
  });
});
