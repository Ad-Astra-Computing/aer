import { describe, it, expect, vi } from 'vitest';
import { parseCloseTimeoutMs } from './cli.js';

describe('parseCloseTimeoutMs', () => {
  it('returns undefined (use the default) when unset', () => {
    const warn = vi.fn();
    expect(parseCloseTimeoutMs({}, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a positive integer string', () => {
    const warn = vi.fn();
    expect(parseCloseTimeoutMs({ AER_CLOSE_TIMEOUT_MS: '20000' }, warn)).toBe(20000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', '3.5', 'not-a-number', ''])(
    'falls back to the default and warns once on an invalid value %p',
    (raw) => {
      const warn = vi.fn();
      expect(parseCloseTimeoutMs({ AER_CLOSE_TIMEOUT_MS: raw }, warn)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).not.toMatch(/bearer|token/i);
    },
  );
});
