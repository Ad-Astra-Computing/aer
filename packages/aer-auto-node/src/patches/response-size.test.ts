import { describe, it, expect } from 'vitest';
import { parseContentLength, responseBytesField } from './response-size.js';

describe('parseContentLength', () => {
  it('parses a clean non-negative integer', () => {
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength('12345')).toBe(12345);
  });

  it('rejects absent, empty and malformed values', () => {
    expect(parseContentLength(null)).toBeUndefined();
    expect(parseContentLength(undefined)).toBeUndefined();
    expect(parseContentLength('')).toBeUndefined();
    expect(parseContentLength('-1')).toBeUndefined();
    expect(parseContentLength('12.5')).toBeUndefined();
    expect(parseContentLength('1e3')).toBeUndefined();
    expect(parseContentLength(' 12 ')).toBeUndefined();
    expect(parseContentLength('0x10')).toBeUndefined();
    expect(parseContentLength('nan')).toBeUndefined();
  });

  it('rejects values beyond the safe integer range', () => {
    expect(parseContentLength('9007199254740993')).toBeUndefined(); // 2^53 + 1
  });

  it('rejects a non-string (e.g. a repeated-header array) at runtime', () => {
    // node:http can surface a string[] for a repeated header. String-coercing
    // ['123'] to '123' must never be mistaken for a real length.
    expect(parseContentLength(['123'] as unknown as string)).toBeUndefined();
    expect(parseContentLength(['1', '2'] as unknown as string)).toBeUndefined();
    expect(parseContentLength(123 as unknown as string)).toBeUndefined();
  });
});

describe('responseBytesField', () => {
  it('yields a spreadable field only when valid', () => {
    expect(responseBytesField('42')).toEqual({ response_bytes: 42 });
    expect(responseBytesField(null)).toEqual({});
    expect(responseBytesField('-1')).toEqual({});
  });
});
