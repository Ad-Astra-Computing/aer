import { describe, it, expect } from 'vitest';
import { enumerateForPlatform } from './real-enumerate.js';

describe('enumerateForPlatform', () => {
  it('selects the linux backend for "linux"', () => {
    expect(typeof enumerateForPlatform('linux')).toBe('function');
  });
  it('selects the macos backend for "darwin"', () => {
    expect(typeof enumerateForPlatform('darwin')).toBe('function');
  });
  it('throws for an unsupported platform', () => {
    expect(() => enumerateForPlatform('win32')).toThrow(/only supported/);
  });
});
