import { describe, it, expect, afterEach } from 'vitest';
import cp from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
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

  // Node's own `exec()` internally calls `module.exports.execFile` - which, once
  // patched, IS the wrapped execFile. Without a reentrancy guard that produces a
  // SECOND process.exec event for the same call, and that second event takes the
  // non-shell code path: `basename(fullString)` on the whole exec command string
  // (keeping every flag/secret after the last path separator) with args[1] being
  // an options object (so redactArgs sees []). This is a real secret leak.
  it('captures exactly ONE process.exec event for exec() and never leaks the raw command/flags', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec('deploy.sh --token=sk-live-12345 target', () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe('deploy.sh');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('sk-live-12345');
    expect(dump).not.toContain('--token');
    uninstall();
  });

  it('captures exactly ONE process.exec event for exec() with a path command and never leaks flags', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec('/usr/local/bin/run.sh --pw=hunter2', () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe('run.sh');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('--pw');
    uninstall();
  });

  it('still captures exactly one event each for spawn/execFile/fork with array args', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve());
      child.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      cp.execFile(process.execPath, ['-e', 'process.exit(0)'], () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(2);
    for (const e of execEvents) {
      expect(e.payload['command']).toBe('node');
      expect(String(e.payload['args_redacted'])).toContain('redacted');
    }
    uninstall();
  });

  it('exec() callback semantics still work and exit is captured exactly once', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    const child = await new Promise<ChildProcess>((resolve) => {
      const c = cp.exec(`${process.execPath} -e "process.exit(0)"`, () => {
        resolve(c);
      });
    });
    expect(child).toBeDefined();

    // Give any (incorrect) duplicate exit listeners a chance to fire.
    await new Promise((r) => setTimeout(r, 20));

    const exitEvents = events.filter((e) => e.event_type === 'process.exit');
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]?.payload['exit_code']).toBe(0);
    uninstall();
  });
});
