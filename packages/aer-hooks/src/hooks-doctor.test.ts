// `staleRegistrations()` must call an aer-hook "wired" only when a harness
// config references it, and never invent a version number for one too old
// to print its own.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleRegistrations } from './hooks-doctor.js';

const savedPath = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = savedPath;
});

function withFakeAerHook(output: string): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), 'aer-hook-fake-'));
  const script = join(binDir, 'aer-hook');
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "${output}"\n`);
  chmodSync(script, 0o755);
  return { binDir, cleanup: () => rmSync(binDir, { recursive: true, force: true }) };
}

describe('staleRegistrations version reporting', () => {
  it('says "on PATH", not "wired", when no harness config references the binary', async () => {
    const { binDir, cleanup } = withFakeAerHook('0.1.0');
    try {
      process.env['PATH'] = binDir;
      const dir = mkdtempSync(join(tmpdir(), 'aer-hooks-empty-project-'));
      try {
        const findings = await staleRegistrations({ dir });
        const versionFinding = findings.find((f) => f.reason === 'outdated_collector');
        expect(versionFinding?.detail).toContain('on PATH');
        expect(versionFinding?.detail).not.toContain('wired');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });

  it('says the version could not be read when the binary prints nothing, and still suggests upgrading', async () => {
    const { binDir, cleanup } = withFakeAerHook('');
    try {
      process.env['PATH'] = binDir;
      const dir = mkdtempSync(join(tmpdir(), 'aer-hooks-empty-project-'));
      try {
        const findings = await staleRegistrations({ dir });
        const versionFinding = findings.find((f) => f.reason === 'outdated_collector');
        expect(versionFinding).toBeDefined();
        expect(versionFinding?.detail).toContain('could not be read');
        expect(versionFinding?.detail).not.toContain('0.0.0');
        expect(versionFinding?.fix).toContain('aer-hooks install');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });
});
