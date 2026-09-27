import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { COLLECTOR_VERSION } from './collector.js';

// COLLECTOR_VERSION is declared at session open and in the closing report.
// It was a literal restated by hand that a release bump never touched, so a
// 0.4.0 install declared itself as 0.3.0.
describe('COLLECTOR_VERSION', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(COLLECTOR_VERSION).toBe(pkg.version);
  });
});
