import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './main.js';

// process.exit really would end the test worker, so every path that reaches
// it is exercised through this stub, which turns the call into a thrown
// error `main()` (and the test) can observe instead.
class ProcessExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('--help short-circuits before any side effect', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aer-cli-help-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitCalled(code ?? 0);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('init --help exits 0, prints usage, and writes nothing to disk', async () => {
    await expect(main(['init', '--help'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('init -h behaves the same as --help', async () => {
    await expect(main(['init', '-h'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('webhooks delete --help performs no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(main(['webhooks', 'delete', '--help'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('commitments verify --help performs no fetch and does not require AER_COMMITMENT_KEY', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(main(['commitments', 'verify', '--help'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('init --session validation', () => {
  let dir: string;
  let originalCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aer-cli-session-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitCalled(code ?? 0);
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('rejects an unrecognized --session value with exit 64 instead of falling back', async () => {
    await expect(main(['init', '--yes', '--session', 'bogus'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('accepts each valid --session value without exiting', async () => {
    for (const value of ['process', 'task', 'server']) {
      await main(['init', '--yes', '--session', value]);
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
