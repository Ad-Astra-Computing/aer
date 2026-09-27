import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';

// A developer shell can export real AER credentials, and a test that spreads
// process.env into a child hands them to the hook, which then records into
// the live service. The suite scrubs AER_* before any test runs and refuses
// to spawn a child whose environment could reach production.

describe('the test environment cannot reach the live service', () => {
  it('starts every test file with no AER_* variable in process.env', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('AER_'))).toEqual([]);
  });

  it('refuses to spawn a child whose base URL is the live API', () => {
    expect(() =>
      spawnSync(process.execPath, ['-e', ''], { env: { PATH: process.env['PATH'], AER_BASE_URL: 'https://api.aer.run' } }),
    ).toThrow(/live AER service/);
  });

  it('refuses to spawn a child holding a key and no base URL, which defaults to the live API', () => {
    expect(() =>
      execFileSync(process.execPath, ['-e', ''], { env: { PATH: process.env['PATH'], AER_API_KEY: 'aer_x' } }),
    ).toThrow(/live AER service/);
    expect(() =>
      spawnSync(process.execPath, ['-e', ''], { env: { PATH: process.env['PATH'], AER_TENANT_API_KEY: 'aer_x' } }),
    ).toThrow(/live AER service/);
  });

  it('refuses any subdomain of the live service, in any variable', () => {
    expect(() =>
      spawnSync(process.execPath, ['-e', ''], {
        env: { PATH: process.env['PATH'], AER_API_KEY: 'k', AER_BASE_URL: 'http://127.0.0.1:1', OTHER: 'https://x.aer.run/v1' },
      }),
    ).toThrow(/live AER service/);
  });

  it('refuses when the child would inherit a process.env that points at the live API', () => {
    process.env['AER_BASE_URL'] = 'https://api.aer.run';
    try {
      expect(() => spawnSync(process.execPath, ['-e', ''])).toThrow(/live AER service/);
    } finally {
      delete process.env['AER_BASE_URL'];
    }
  });

  it('lets a child pointed at a local sink run', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      env: { PATH: process.env['PATH'], AER_API_KEY: 'k', AER_BASE_URL: 'http://127.0.0.1:9' },
    });
    expect(r.status).toBe(0);
  });

  it('refuses an in-process fetch to the live API', async () => {
    await expect(fetch('https://api.aer.run/healthz')).rejects.toThrow(/live AER service/);
  });
});
