// Drives the BUILT dist, not the source module, through every entry point a
// real consumer can reach node:child_process by: a named import (which binds
// its function reference before the patch is installed, the exact shape that
// let a secret-bearing shell command slip past `safeExtract` and into a
// signed record), promisify() of that same named import, execSync (not
// patched at all, so it must simply produce no leaking event), and
// default-import property access for exec/execFile/spawn/fork. Every case
// plants a secret marker in the command line and asserts it never survives
// into a captured event, and that a captured `process.exec` command is
// always a bare executable basename.
import { describe, it, expect, afterEach } from 'vitest';
import cpDefault, { exec as namedExec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CollectorEvent } from '../session.js';
// Imported from dist on purpose: this test exists to catch regressions that
// only show up in the compiled artifact a consumer actually installs.
import { installChildProcessPatch } from '../../dist/patches/child-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORK_CHILD = path.join(__dirname, 'fixtures', 'fork-child.mjs');
const NODE = process.execPath;
const SECRET = 'SECRET_MARKER_9f2c1e4a';

afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('adastra.aer.patched.child_process')];
});

function withCapture() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

function assertNoSecretLeak(events: CollectorEvent[]): void {
  const dump = JSON.stringify(events);
  expect(dump).not.toContain(SECRET);
}

describe('installChildProcessPatch against the built dist', () => {
  it('named-import exec: command is the basename only, secret never leaks', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      // `namedExec` was bound at module load time, before the patch above
      // installed - the exact shape that reaches child_process only through
      // Node's own internal (patched) execFile call.
      namedExec(`${NODE} -e "process.exit(0)" ${SECRET}`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    assertNoSecretLeak(events);
    uninstall();
  });

  it('promisify(namedExec): same basename-only guarantee', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);
    const run = promisify(namedExec);

    await run(`${NODE} -e "process.exit(0)" ${SECRET}`);

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    assertNoSecretLeak(events);
    uninstall();
  });

  it('a leading SECRET=value env prefix through a named-import exec never leaks', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      namedExec(`API_KEY=${SECRET} ${NODE} -e "process.exit(0)"`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    expect(JSON.stringify(events)).not.toContain('API_KEY');
    assertNoSecretLeak(events);
    uninstall();
  });

  it('execSync is not patched: no event is emitted, so nothing can leak', () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    execSync(`${NODE} -e "process.exit(0)" ${SECRET}`);

    expect(events.filter((e) => e.event_type === 'process.exec')).toHaveLength(0);
    assertNoSecretLeak(events);
    uninstall();
  });

  it('default-import cp.exec: command is the basename only, secret never leaks', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      cpDefault.exec(`${NODE} -e "process.exit(0)" ${SECRET}`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    assertNoSecretLeak(events);
    uninstall();
  });

  it('default-import cp.execFile with a real argv array: args are redacted, never leaked', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      cpDefault.execFile(NODE, ['-e', 'process.exit(0)', SECRET], (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    expect(String(execEvents[0]?.payload['args_redacted'])).toContain('redacted');
    assertNoSecretLeak(events);
    uninstall();
  });

  it('default-import cp.spawn with a real argv array: args are redacted, never leaked', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cpDefault.spawn(NODE, ['-e', 'process.exit(0)', SECRET]);
      child.once('exit', () => resolve());
      child.once('error', reject);
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(NODE));
    assertNoSecretLeak(events);
    uninstall();
  });

  it('default-import cp.fork: command is the basename only, secret never leaks', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cpDefault.fork(FORK_CHILD, [SECRET], { stdio: 'ignore' });
      child.once('exit', () => resolve());
      child.once('error', reject);
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe(path.basename(FORK_CHILD));
    assertNoSecretLeak(events);
    uninstall();
  });
});
