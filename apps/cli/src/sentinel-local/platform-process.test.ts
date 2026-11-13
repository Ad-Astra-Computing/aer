import { describe, it, expect, vi } from 'vitest';
import { SystemdUserController, LaunchdUserController, detectSourcePlatform } from './platform-process.js';

describe('detectSourcePlatform', () => {
  it('maps linux/darwin, and nothing else', () => {
    expect(detectSourcePlatform('linux')).toBe('linux');
    expect(detectSourcePlatform('darwin')).toBe('macos');
    expect(detectSourcePlatform('win32')).toBeUndefined();
  });
});

describe('SystemdUserController', () => {
  it('enableAndStart reloads then enables --now', async () => {
    const calls: string[][] = [];
    const execFn = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; });
    await new SystemdUserController(execFn).enableAndStart();
    expect(calls[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls[1]![2]).toBe('enable');
  });

  it('isActive reflects systemctl is-active output', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: 'active\n', stderr: '' }));
    expect(await new SystemdUserController(execFn).isActive()).toBe(true);
  });

  it('stop/start never call disable (pause/resume are local-only)', async () => {
    const calls: string[][] = [];
    const execFn = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; });
    const c = new SystemdUserController(execFn);
    await c.stop();
    await c.start();
    expect(calls.flat().join(' ')).not.toContain('disable');
  });

  // B1: a nonzero exit code from a mutating subprocess call is production
  // reality (systemctl never throws, it just exits nonzero), not a thrown
  // rejection - every mutating method must check `code` itself.
  it('enableAndStart throws when daemon-reload exits nonzero', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Failed to reload daemon' }));
    await expect(new SystemdUserController(execFn).enableAndStart()).rejects.toThrow(/Failed to reload daemon|1/);
  });

  it('enableAndStart throws when enable --now exits nonzero (daemon-reload itself succeeded)', async () => {
    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      if (args[1] === 'daemon-reload') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'Unit not found' };
    });
    await expect(new SystemdUserController(execFn).enableAndStart()).rejects.toThrow(/Unit not found|1/);
  });

  it('stop throws when systemctl stop exits nonzero', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such unit' }));
    await expect(new SystemdUserController(execFn).stop()).rejects.toThrow(/no such unit|1/);
  });

  it('start throws when systemctl start exits nonzero', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such unit' }));
    await expect(new SystemdUserController(execFn).start()).rejects.toThrow(/no such unit|1/);
  });

  it('disableAndStop does NOT throw on a nonzero exit (best-effort, uninstall must proceed)', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such unit' }));
    await expect(new SystemdUserController(execFn).disableAndStop()).resolves.toBeUndefined();
  });
});

describe('LaunchdUserController', () => {
  it('isActive reflects launchctl list exit code', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }));
    expect(await new LaunchdUserController(execFn, '/plist').isActive()).toBe(false);
  });

  it('enableAndStart throws when launchctl bootstrap exits nonzero without rejecting', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }));
    await expect(new LaunchdUserController(execFn, '/plist').enableAndStart()).rejects.toThrow(/Bootstrap failed|1/);
  });

  it('start throws when launchctl bootstrap exits nonzero without rejecting', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Bootstrap failed' }));
    await expect(new LaunchdUserController(execFn, '/plist').start()).rejects.toThrow(/Bootstrap failed|1/);
  });

  it('disableAndStop does NOT throw on a nonzero exit (best-effort, uninstall must proceed)', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such service' }));
    await expect(new LaunchdUserController(execFn, '/plist').disableAndStop()).resolves.toBeUndefined();
  });
});
