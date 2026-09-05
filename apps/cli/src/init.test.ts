import { describe, it, expect } from 'vitest';
import { planInit, applyInit, runDoctor, type FsLike } from './init.js';

function memFs(seed: Record<string, string> = {}): FsLike & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    readFile: (p) => (p in files ? files[p]! : null),
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
  };
}

const CWD = '/proj';

function pkg(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'my-agent',
    scripts: { start: 'node dist/main.js', dev: 'tsx src/main.ts', test: 'vitest' },
    dependencies: { openai: '^5.0.0' },
    devDependencies: { '@anthropic-ai/sdk': '^0.30.0' },
    ...extra,
  });
}

describe('planInit, detection', () => {
  it('detects the package manager from the lockfile', () => {
    const fs = memFs({ '/proj/package.json': pkg(), '/proj/pnpm-lock.yaml': '' });
    expect(planInit(fs, { cwd: CWD }).detect.packageManager).toBe('pnpm');
  });

  it('detects OpenAI + Anthropic SDKs and maps them to adapters', () => {
    const fs = memFs({ '/proj/package.json': pkg(), '/proj/package-lock.json': '' });
    const plan = planInit(fs, { cwd: CWD });
    expect(plan.detect.sdks.sort()).toEqual(['@anthropic-ai/sdk', 'openai']);
    expect(plan.detect.adapters.sort()).toEqual(['anthropic', 'openai']);
  });

  it('collects runnable entrypoints from package.json scripts', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD });
    expect(plan.detect.entrypoints).toContain('start');
    expect(plan.detect.entrypoints).toContain('dev');
    expect(plan.detect.entrypoints).not.toContain('test');
  });
});

describe('planInit, files and wiring', () => {
  it('plans aer.config.json with identity but never the API key', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD, tenantId: 't-1', agentId: 'a-1', envId: 'e-1' });
    const cfg = plan.files.find((f) => f.path.endsWith('aer.config.json'));
    expect(cfg).toBeDefined();
    const parsed = JSON.parse(cfg!.content);
    expect(parsed).toMatchObject({ schema: 'aer.config.v1', tenant_id: 't-1', agent_id: 'a-1', env_id: 'e-1' });
    expect(JSON.stringify(parsed)).not.toContain('AER_API_KEY');
    expect(parsed.api_key).toBeUndefined();
  });

  it('plans a .env.example that contains only the secret', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD });
    const env = plan.files.find((f) => f.path.endsWith('.env.example'));
    expect(env?.content).toContain('AER_API_KEY=');
    // identity vars are commented optional overrides, not required secrets
    expect(env?.content).toMatch(/#\s*AER_TENANT_ID/);
  });

  it('wires the register via NODE_OPTIONS into runnable scripts', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD });
    const start = plan.scriptChanges.find((s) => s.script === 'start');
    expect(start?.after).toContain('--import @adastracomputing/aer-auto-node/register');
    expect(start?.after).toContain('node dist/main.js');
  });

  it('emits an aer.integration.v1 manifest the coding agent consumes', () => {
    const fs = memFs({ '/proj/package.json': pkg(), '/proj/pnpm-lock.yaml': '' });
    const plan = planInit(fs, { cwd: CWD });
    expect(plan.manifest.schema).toBe('aer.integration.v1');
    expect(plan.manifest.package_manager).toBe('pnpm');
    expect(plan.manifest.env_required).toEqual(['AER_API_KEY']);
    expect(plan.manifest.instrumentation.register).toBe('@adastracomputing/aer-auto-node/register');
    expect(plan.manifest.instrumentation.adapters.sort()).toEqual(['anthropic', 'openai']);
    expect(plan.manifest.files_changed).toContain('package.json');
  });

  it('does not clobber an existing aer.config.json (skip)', () => {
    const fs = memFs({ '/proj/package.json': pkg(), '/proj/aer.config.json': '{"existing":true}' });
    const plan = planInit(fs, { cwd: CWD });
    const cfg = plan.files.find((f) => f.path.endsWith('aer.config.json'));
    expect(cfg?.action).toBe('skip');
  });

  it('labels AER_INTEGRATION.md and aer.integration.json "create" when they do not exist yet', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD });
    const md = plan.files.find((f) => f.path.endsWith('AER_INTEGRATION.md'));
    const manifest = plan.files.find((f) => f.path.endsWith('aer.integration.json'));
    expect(md?.action).toBe('create');
    expect(manifest?.action).toBe('create');
  });

  it('labels AER_INTEGRATION.md and aer.integration.json "overwrite" when they already exist', () => {
    const fs = memFs({
      '/proj/package.json': pkg(),
      '/proj/AER_INTEGRATION.md': '# old',
      '/proj/aer.integration.json': '{"old":true}',
    });
    const plan = planInit(fs, { cwd: CWD });
    const md = plan.files.find((f) => f.path.endsWith('AER_INTEGRATION.md'));
    const manifest = plan.files.find((f) => f.path.endsWith('aer.integration.json'));
    expect(md?.action).toBe('overwrite');
    expect(manifest?.action).toBe('overwrite');
  });

  it('--entry wires the named script even if it is not auto-detected as runnable', () => {
    const fs = memFs({ '/proj/package.json': pkg({ scripts: { start: 'node dist/main.js', worker: 'node dist/worker.js' } }) });
    const plan = planInit(fs, { cwd: CWD, entry: 'worker' });
    const change = plan.scriptChanges.find((s) => s.script === 'worker');
    expect(change?.after).toContain('--import @adastracomputing/aer-auto-node/register');
    expect(change?.after).toContain('node dist/worker.js');
    expect(plan.manifest.entrypoints).toEqual(['worker']);
    expect(plan.manifest.files_changed).toContain('package.json');
  });

  it('--entry with an unknown script throws a clear error instead of silently succeeding', () => {
    const fs = memFs({ '/proj/package.json': pkg({ scripts: { start: 'node dist/main.js' } }) });
    expect(() => planInit(fs, { cwd: CWD, entry: 'does-not-exist' })).toThrow(/does-not-exist/);
  });

  it('does not claim package.json changed when there is nothing to wire', () => {
    // No runnable entrypoints detected and no --entry given.
    const fs = memFs({ '/proj/package.json': pkg({ scripts: { test: 'vitest' } }) });
    const plan = planInit(fs, { cwd: CWD });
    expect(plan.scriptChanges).toHaveLength(0);
    expect(plan.manifest.files_changed).not.toContain('package.json');
  });
});

describe('applyInit', () => {
  it('writes planned files and updates package.json scripts', () => {
    const fs = memFs({ '/proj/package.json': pkg() });
    const plan = planInit(fs, { cwd: CWD, tenantId: 't-1', agentId: 'a-1', envId: 'e-1' });
    applyInit(fs, plan);

    expect(fs.exists('/proj/aer.config.json')).toBe(true);
    expect(fs.exists('/proj/.env.example')).toBe(true);
    expect(fs.exists('/proj/AER_INTEGRATION.md')).toBe(true);
    expect(fs.exists('/proj/aer.integration.json')).toBe(true);
    const updated = JSON.parse(fs.files['/proj/package.json']!);
    expect(updated.scripts.start).toContain('@adastracomputing/aer-auto-node/register');
    // unrelated scripts are untouched
    expect(updated.scripts.test).toBe('vitest');
  });
});

describe('runDoctor', () => {
  it('passes when the package is wired, config valid, and API key present', () => {
    const fs = memFs({
      '/proj/package.json': JSON.stringify({
        scripts: { start: 'NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register" node dist/main.js' },
        devDependencies: { '@adastracomputing/aer-auto-node': 'workspace:*' },
      }),
      '/proj/aer.config.json': JSON.stringify({ schema: 'aer.config.v1', tenant_id: 't', agent_id: 'a', env_id: 'e' }),
    });
    const report = runDoctor(fs, { cwd: CWD, env: { AER_API_KEY: 'k' } });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails with actionable checks when nothing is set up', () => {
    const fs = memFs({ '/proj/package.json': JSON.stringify({ scripts: {} }) });
    const report = runDoctor(fs, { cwd: CWD, env: {} });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('package_installed');
    expect(failed).toContain('register_wired');
    expect(failed).toContain('config_present');
    expect(failed).toContain('api_key_present');
  });

  it('accepts AER_TENANT_API_KEY as a fallback for api_key_present (matches the live tenant-auth check + help text)', () => {
    const fs = memFs({
      '/proj/package.json': JSON.stringify({
        scripts: { start: 'NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register" node dist/main.js' },
        devDependencies: { '@adastracomputing/aer-auto-node': 'workspace:*' },
      }),
      '/proj/aer.config.json': JSON.stringify({ schema: 'aer.config.v1', tenant_id: 't', agent_id: 'a', env_id: 'e' }),
    });
    const report = runDoctor(fs, { cwd: CWD, env: { AER_TENANT_API_KEY: 'k' } });
    const apiKeyCheck = report.checks.find((c) => c.name === 'api_key_present');
    expect(apiKeyCheck?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });
});
