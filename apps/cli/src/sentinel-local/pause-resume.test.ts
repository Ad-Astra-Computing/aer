import { describe, it, expect, vi } from 'vitest';
import { runPause, runResume } from './pause-resume.js';

describe('pause/resume: local-only, never touch the server', () => {
  it('pause calls systemctl stop, nothing else', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runPause({ execFn, platform: 'linux' });
    expect(execFn).toHaveBeenCalledWith('systemctl', ['--user', 'stop', expect.any(String)]);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('resume calls systemctl start, nothing else', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runResume({ execFn, platform: 'linux' });
    expect(execFn).toHaveBeenCalledWith('systemctl', ['--user', 'start', expect.any(String)]);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('on macos, pause uses launchctl bootout', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runPause({ execFn, platform: 'macos' });
    expect(execFn).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootout']));
  });
});
