import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './install-cli.js';

// The installer's exit codes are a contract: a shell script, a CI smoke step
// or a Nix check that runs `aer-hooks --help` treats a non-zero exit as a
// broken binary. Asking for help is not a usage error.
function capture(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
}

describe('aer-hooks exit codes', () => {
  for (const flag of ['--help', '-h', 'help']) {
    it(`prints usage and exits 0 for ${flag}`, async () => {
      const c = capture();
      const code = await run([flag], c.out, c.err);
      expect(code).toBe(0);
      expect(c.stdout.join('\n')).toContain('aer-hooks install');
    });
  }

  it('prints usage and exits 0 when invoked with no arguments', async () => {
    const c = capture();
    const code = await run([], c.out, c.err);
    expect(code).toBe(0);
    expect(c.stdout.join('\n')).toContain('aer-hooks install');
  });

  it('exits 2 for an unrecognized command', async () => {
    const c = capture();
    const code = await run(['frobnicate'], c.out, c.err);
    expect(code).toBe(2);
  });

  it('exits 2 when install is given no harness', async () => {
    const c = capture();
    const code = await run(['install'], c.out, c.err);
    expect(code).toBe(2);
    expect(c.stderr.join('\n')).toContain('claude-code');
  });

  it('exits 2 when install is given an unknown harness', async () => {
    const c = capture();
    const code = await run(['install', 'emacs'], c.out, c.err);
    expect(code).toBe(2);
  });
});

// Codex skips a hook it has not been told to trust, and says nothing when it
// does. An installer that prints "wired" and stops sends the user away
// believing they are recording when they are not.
describe('Codex hook trust', () => {
  it('tells the user to trust the hook after installing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-hookcfg-'));
    try {
      const lines: string[] = [];
      const code = await run(['install', 'codex', '--dir', dir], (s) => lines.push(s));
      expect(code).toBe(0);
      const out = lines.join('\n');
      expect(out).toContain('/hooks');
      expect(out.toLowerCase()).toContain('trust');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing about trust for the harnesses that do not require it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-hookcfg-'));
    try {
      const lines: string[] = [];
      await run(['install', 'claude-code', '--dir', dir], (s) => lines.push(s));
      expect(lines.join('\n').toLowerCase()).not.toContain('trust');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeats it in status, where a user checks why nothing is recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-hookcfg-'));
    try {
      await run(['install', 'codex', '--dir', dir], () => {});
      const lines: string[] = [];
      await run(['status', '--dir', dir], (s) => lines.push(s));
      expect(lines.join('\n')).toContain('/hooks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
