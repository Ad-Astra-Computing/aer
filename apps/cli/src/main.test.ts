import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('import names what is missing instead of printing all of usage', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const IMPORT_ENV = ['AER_BASE_URL', 'AER_TENANT_API_KEY', 'AER_API_KEY', 'AER_TENANT_ID', 'AER_AGENT_ID', 'AER_ENV_ID'];

  const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aer-cli-import-'));
    for (const name of IMPORT_ENV) vi.stubEnv(name, '');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitCalled(code ?? 0);
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('lists every unset variable, and only those', async () => {
    vi.stubEnv('AER_BASE_URL', 'https://api.test');
    vi.stubEnv('AER_TENANT_API_KEY', 'k');
    await expect(main(['import', 'claude-code', join(dir, 's.jsonl')])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(64);
    const out = stderr();
    for (const name of ['AER_TENANT_ID', 'AER_AGENT_ID', 'AER_ENV_ID']) expect(out).toContain(name);
    expect(out).not.toContain('AER_BASE_URL');
    expect(out).not.toContain('aer webhooks deliveries');
  });

  it('says a format is needed when the file comes first', async () => {
    await expect(main(['import', 'history.jsonl'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(stderr()).toContain('aer import claude-code <file.jsonl>');
    expect(stderr()).not.toContain('aer webhooks deliveries');
  });

  it('says where Claude Code keeps transcripts when no file is given', async () => {
    await expect(main(['import', 'claude-code'])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(stderr()).toContain('~/.claude/projects');
  });

  it('takes the identity from aer.config.json, where aer init writes it', async () => {
    writeFileSync(join(dir, 'aer.config.json'), JSON.stringify({
      schema: 'aer.config.v1', tenant_id: 't', agent_id: 'a', env_id: 'e', base_url: 'https://api.test',
    }));
    vi.stubEnv('AER_TENANT_API_KEY', 'k');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(main(['import', 'claude-code', join(dir, 'nope.jsonl')])).rejects.toThrow(ProcessExitCalled);
    } finally {
      process.chdir(cwd);
    }
    // Past the variable check: it is the file that is refused now.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr()).toContain('nope.jsonl');
  });

  it('treats a placeholder in aer.config.json as unset', async () => {
    writeFileSync(join(dir, 'aer.config.json'), JSON.stringify({
      schema: 'aer.config.v1', tenant_id: 'REPLACE_WITH_TENANT_ID', agent_id: 'a', env_id: 'e',
    }));
    vi.stubEnv('AER_TENANT_API_KEY', 'k');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(main(['import', 'claude-code', join(dir, 's.jsonl')])).rejects.toThrow(ProcessExitCalled);
    } finally {
      process.chdir(cwd);
    }
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(stderr()).toContain('AER_TENANT_ID');
    expect(stderr()).not.toContain('AER_AGENT_ID');
  });

  it('lists the newest transcripts for this directory when no file is given', async () => {
    const project = join(dir, 'work', 'my.app');
    const slug = project.replace(/[^A-Za-z0-9]/g, '-');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(dir, '.claude', 'projects', slug), { recursive: true });
    writeFileSync(join(dir, '.claude', 'projects', slug, 'aaaa.jsonl'), '{}');
    vi.stubEnv('HOME', dir);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      await expect(main(['import', 'claude-code'])).rejects.toThrow(ProcessExitCalled);
    } finally {
      process.chdir(cwd);
    }
    expect(stderr()).toContain(`~/.claude/projects/${slug}/aaaa.jsonl`);
  });

  it('names a file that cannot be read before any network call', async () => {
    for (const [name, value] of [['AER_BASE_URL', 'https://api.test'], ['AER_TENANT_API_KEY', 'k'], ['AER_TENANT_ID', 't'], ['AER_AGENT_ID', 'a'], ['AER_ENV_ID', 'e']]) {
      vi.stubEnv(name!, value!);
    }
    const missing = join(dir, 'nope.jsonl');
    await expect(main(['import', 'claude-code', missing])).rejects.toThrow(ProcessExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr()).toContain(missing);
    expect(fetch).not.toHaveBeenCalled();
  });
});
