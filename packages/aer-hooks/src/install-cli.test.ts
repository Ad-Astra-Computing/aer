import { describe, it, expect } from 'vitest';
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
