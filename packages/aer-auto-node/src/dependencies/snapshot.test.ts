import { describe, it, expect } from 'vitest';
import { buildDependencySnapshot } from './snapshot.js';

// Virtual filesystem keyed by absolute path. Missing paths return null.
function fakeFs(files: Record<string, string>) {
  return (p: string): string | null => (p in files ? files[p]! : null);
}

const CWD = '/app';

function baseFiles(): Record<string, string> {
  return {
    '/app/package.json': JSON.stringify({
      name: 'my-agent',
      dependencies: { openai: '^5.0.0' },
      devDependencies: { typescript: '~5.8.0' },
    }),
    '/app/node_modules/openai/package.json': JSON.stringify({ name: 'openai', version: '5.1.2' }),
    '/app/node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.8.3' }),
    '/app/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  };
}

const deps = (files: Record<string, string>) => ({
  cwd: CWD,
  readFile: fakeFs(files),
  nodeVersion: '24.0.0',
  versions: { node: '24.0.0', v8: '12.0' },
});

describe('buildDependencySnapshot', () => {
  it('resolves installed versions from node_modules and sorts by name', () => {
    const snap = buildDependencySnapshot(deps(baseFiles()));
    expect(snap.runtime).toBe('node');
    expect(snap.node_version).toBe('24.0.0');
    expect(snap.packages).toEqual([
      { name: 'openai', version: '5.1.2' },
      { name: 'typescript', version: '5.8.3' },
    ]);
  });

  it('detects the package manager and hashes the lockfile', () => {
    const snap = buildDependencySnapshot(deps(baseFiles()));
    expect(snap.package_manager).toBe('pnpm');
    expect(snap.lockfile_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('falls back to the declared range when the package is not installed', () => {
    const files = baseFiles();
    delete files['/app/node_modules/openai/package.json'];
    const snap = buildDependencySnapshot(deps(files));
    expect(snap.packages.find((p) => p.name === 'openai')?.version).toBe('^5.0.0');
  });

  it('produces a deterministic snapshot_hash for identical inputs', () => {
    const a = buildDependencySnapshot(deps(baseFiles()));
    const b = buildDependencySnapshot(deps(baseFiles()));
    expect(a.snapshot_hash).toBe(b.snapshot_hash);
    expect(a.snapshot_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('handles a missing package.json gracefully', () => {
    const snap = buildDependencySnapshot(deps({}));
    expect(snap.packages).toEqual([]);
    expect(snap.package_manager).toBeUndefined();
    expect(snap.lockfile_hash).toBeUndefined();
    expect(snap.runtime).toBe('node');
    expect(snap.snapshot_hash).toMatch(/^sha256:/);
  });

  it('detects npm via package-lock.json', () => {
    const files = baseFiles();
    delete files['/app/pnpm-lock.yaml'];
    files['/app/package-lock.json'] = '{"lockfileVersion":3}';
    expect(buildDependencySnapshot(deps(files)).package_manager).toBe('npm');
  });
});
