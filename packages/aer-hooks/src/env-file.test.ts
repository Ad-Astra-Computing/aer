// Credentials for the hook alone. Exported in a shell profile, an AER key
// reaches every command an agent runs from that shell, and anything that
// loads an AER emitter records under the harness agent. A file read only by
// the hook process keeps the key out of that environment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readEnvFile, envWithFile } from './env-file.js';
import { runHook } from './cli.js';
import { install } from './install.js';
import { run as installCli } from './install-cli.js';
import { staleRegistrations } from './hooks-doctor.js';
import { FakeApi } from './fake-api.test-support.js';

let dir: string;

function writeFile(name: string, text: string, mode = 0o600): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, { mode });
  fs.chmodSync(p, mode);
  return p;
}

const GOOD = [
  '# AER credentials for the hooks',
  'export AER_API_KEY=aer_file_key',
  'AER_TENANT_ID="tenant-from-file"',
  "AER_AGENT_ID='agent-from-file'",
  'AER_BASE_URL=http://aer.test',
  'AER_ENV_ID=01950000-0000-7000-8000-0000000000ad',
  'PATH=/should/not/apply',
  '',
].join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-envfile-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading the credential file', () => {
  it('reads AER_* values from an owner-only file and ignores everything else', () => {
    const r = readEnvFile(writeFile('hooks.env', GOOD));
    expect(r).toEqual({
      values: { AER_API_KEY: 'aer_file_key', AER_TENANT_ID: 'tenant-from-file', AER_AGENT_ID: 'agent-from-file', AER_BASE_URL: 'http://aer.test', AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad' },
    });
  });

  it('reads a quoted value with a comment after it, and an unquoted # the way a shell does', () => {
    const p = writeFile('comments.env', [
      'AER_API_KEY="abc" # the key',
      "AER_TENANT_ID='t#1'   # quoted hash stays",
      'AER_AGENT_ID=agent-1 # trailing',
      'AER_ENV_ID=env#part-of-it',
      'AER_PRINCIPAL_ID=#only-a-comment',
      'AER_BASE_URL="http://aer.test"',
    ].join('\n'));
    expect(readEnvFile(p)).toEqual({
      values: { AER_API_KEY: 'abc', AER_TENANT_ID: 't#1', AER_AGENT_ID: 'agent-1', AER_ENV_ID: 'env#part-of-it', AER_PRINCIPAL_ID: '', AER_BASE_URL: 'http://aer.test' },
    });
  });

  it('refuses a file other users can read or write, and never repeats its contents', () => {
    for (const mode of [0o640, 0o604, 0o620, 0o644]) {
      const p = writeFile(`loose-${mode.toString(8)}.env`, GOOD, mode);
      const r = readEnvFile(p);
      expect('refused' in r && r.refused).toMatch(/chmod 600/);
      expect(JSON.stringify(r)).not.toContain('aer_file_key');
    }
  });

  it('refuses a link, a directory and a missing file', () => {
    const real = writeFile('real.env', GOOD);
    const link = path.join(dir, 'link.env');
    fs.symlinkSync(real, link);
    expect('refused' in readEnvFile(link)).toBe(true);
    expect('refused' in readEnvFile(dir)).toBe(true);
    expect('refused' in readEnvFile(path.join(dir, 'absent.env'))).toBe(true);
  });

  it('applies the file over the environment for the hook only, leaving process.env alone', () => {
    const p = writeFile('hooks.env', GOOD);
    const base = { AER_API_KEY: 'from-shell', HOME: '/h' } as NodeJS.ProcessEnv;
    const merged = envWithFile(['--harness', 'claude-code', '--env-file', p], base, () => undefined);
    expect(merged['AER_API_KEY']).toBe('aer_file_key');
    expect(merged['HOME']).toBe('/h');
    expect(merged['PATH']).toBeUndefined();
    expect(base['AER_API_KEY']).toBe('from-shell');
    expect(process.env['AER_API_KEY']).toBeUndefined();
  });

  it('also takes the path from AER_ENV_FILE', () => {
    const p = writeFile('hooks.env', GOOD);
    expect(envWithFile([], { AER_ENV_FILE: p } as NodeJS.ProcessEnv, () => undefined)['AER_AGENT_ID']).toBe('agent-from-file');
  });

  it('says why it refused, once, without the values', () => {
    const p = writeFile('loose.env', GOOD, 0o644);
    const lines: string[] = [];
    const merged = envWithFile(['--env-file', p], {}, (m) => lines.push(m));
    expect(merged['AER_API_KEY']).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(p);
    expect(lines[0]).not.toContain('aer_file_key');
  });
});

describe('a hook pointed at the credential file', () => {
  it('records with the file\'s credentials and leaves them out of process.env', async () => {
    const api = new FakeApi();
    const p = writeFile('hooks.env', GOOD);
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2', '--env-file', p], { XDG_CACHE_HOME: path.join(dir, 'cache') }, {
      readInput: async () => JSON.stringify({ session_id: 'cc-envfile', cwd: dir, hook_event_name: 'SessionStart' }),
      fetch: api.fetch,
    });
    expect(api.opens()).toHaveLength(1);
    const open = api.opens()[0]!.body as Record<string, unknown>;
    expect(open['tenant_id']).toBe('tenant-from-file');
    expect(open['agent_id']).toBe('agent-from-file');
    expect(Object.keys(process.env).filter((k) => k.startsWith('AER_'))).toEqual([]);
  });

  it('does nothing when the file is refused and nothing else configures it', async () => {
    const api = new FakeApi();
    const p = writeFile('loose.env', GOOD, 0o644);
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2', '--env-file', p], { XDG_CACHE_HOME: path.join(dir, 'cache') }, {
      readInput: async () => JSON.stringify({ session_id: 'cc-loose', cwd: dir, hook_event_name: 'SessionStart' }),
      fetch: api.fetch,
      logError: () => undefined,
    });
    expect(api.requests).toHaveLength(0);
  });
});

describe('installing with a credential file', () => {
  it('writes the file into every command, and keeps it when installed again without it', async () => {
    const p = writeFile('hooks.env', GOOD);
    const home = path.join(dir, 'home');
    await install('claude-code', { dir: home, envFile: p });
    const cmds = () => {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      return Object.values(cfg.hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
    };
    expect(cmds().length).toBe(10);
    for (const c of cmds()) expect(c).toContain(`--env-file '${p}'`);
    await install('claude-code', { dir: home });
    for (const c of cmds()) expect(c).toContain(`--env-file '${p}'`);
  });

  it('refuses a credential file other users can read', async () => {
    const p = writeFile('loose.env', GOOD, 0o644);
    const out: string[] = [];
    const err: string[] = [];
    const code = await installCli(['install', 'claude-code', '--dir', path.join(dir, 'home'), '--env-file', p], (s) => out.push(s), (s) => err.push(s));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/chmod 600/);
    expect(fs.existsSync(path.join(dir, 'home', '.claude', 'settings.json'))).toBe(false);
  });
});

describe('status and doctor', () => {
  it('warn when an AER key is exported in the shell and hooks are wired', async () => {
    const home = path.join(dir, 'home');
    await install('claude-code', { dir: home });
    process.env['AER_API_KEY'] = 'k';
    try {
      const findings = await staleRegistrations({ dir: home });
      const f = findings.find((x) => x.reason === 'key_in_shell_env');
      expect(f?.detail).toMatch(/every command/);
      expect(f?.fix).toContain('--env-file');
      expect(JSON.stringify(findings)).not.toContain('"k"');
    } finally {
      delete process.env['AER_API_KEY'];
    }
  });

  it('stay quiet about the key when no hooks are wired', async () => {
    process.env['AER_API_KEY'] = 'k';
    try {
      const findings = await staleRegistrations({ dir: path.join(dir, 'empty-home') });
      expect(findings.some((x) => x.reason === 'key_in_shell_env')).toBe(false);
    } finally {
      delete process.env['AER_API_KEY'];
    }
  });
});
