import { describe, it, expect, afterEach } from 'vitest';
import cp from 'node:child_process';
import { installChildProcessPatch } from './child-process.js';
import type { CollectorEvent } from '../session.js';

afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('adastra.aer.patched.child_process')];
});

function withCapture() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

describe('installChildProcessPatch', () => {
  it('emits process.exec (basename + redacted args) and process.exit for spawn', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve());
      child.on('error', reject);
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    const exit = events.find((e) => e.event_type === 'process.exit');
    expect(exec?.payload['command']).toBe('node');
    expect(String(exec?.payload['args_redacted'])).toContain('redacted');
    // must NOT leak the actual args
    expect(JSON.stringify(exec?.payload)).not.toContain('process.exit(0)');
    expect(exit?.payload['exit_code']).toBe(0);
    uninstall();
  });

  it('captures exec() shell commands by leading binary, exit code preserved', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec(`${process.execPath} -e "process.exit(3)"`, () => resolve());
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    const exit = events.find((e) => e.event_type === 'process.exit');
    expect(exec?.payload['command']).toBe('node');
    expect(exit?.payload['exit_code']).toBe(3);
    uninstall();
  });

  it('does not leak a leading env-assignment value into the exec command', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      // Inline secret passed as a shell env prefix: the value must never surface.
      cp.exec(`API_KEY=sk-super-secret ${process.execPath} -e "process.exit(0)"`, () => resolve());
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    expect(exec?.payload['command']).toBe('node');
    // The secret value must appear nowhere in the captured event.
    expect(JSON.stringify(exec?.payload)).not.toContain('sk-super-secret');
    expect(JSON.stringify(exec?.payload)).not.toContain('API_KEY');
    uninstall();
  });

  it('is idempotent and restores originals on uninstall', () => {
    const original = cp.spawn;
    const { capture } = withCapture();
    const u1 = installChildProcessPatch(capture);
    const u2 = installChildProcessPatch(capture);
    expect(cp.spawn).not.toBe(original);
    u2(); u1();
    expect(cp.spawn).toBe(original);
  });

  it('never breaks the child process if capture throws', async () => {
    const uninstall = installChildProcessPatch(() => { throw new Error('boom'); });
    const code = await new Promise<number>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', (c) => resolve(c ?? -1));
      child.on('error', reject);
    });
    expect(code).toBe(0);
    uninstall();
  });
});
