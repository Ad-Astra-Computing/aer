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
});

describe('LaunchdUserController', () => {
  it('isActive reflects launchctl list exit code', async () => {
    const execFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }));
    expect(await new LaunchdUserController(execFn, '/plist').isActive()).toBe(false);
  });
});
