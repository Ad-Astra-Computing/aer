// Build the dependency snapshot: the agent's declared dependencies resolved to
// their installed versions (from node_modules), the package manager, and a
// lockfile hash for integrity. Pure + injectable so it's fully unit-tested.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageEntry { name: string; version: string }

export interface DependencySnapshot {
  runtime: 'node';
  node_version: string;
  package_manager?: string;
  packages: PackageEntry[];
  lockfile_hash?: string;
  snapshot_hash: string;
  versions?: Record<string, string | undefined>;
}

export interface SnapshotDeps {
  cwd?: string;
  /** Read a file by absolute path; return null when it does not exist. */
  readFile?: (absPath: string) => string | null;
  nodeVersion?: string;
  versions?: Record<string, string | undefined>;
  hash?: (input: string) => string;
}

const LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
];

function defaultReadFile(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function sha256(input: string): string {
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

export function buildDependencySnapshot(deps: SnapshotDeps = {}): DependencySnapshot {
  const cwd = deps.cwd ?? process.cwd();
  const readFile = deps.readFile ?? defaultReadFile;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const versions = deps.versions ?? { ...process.versions };
  const hash = deps.hash ?? sha256;

  const declared = readDeclaredDeps(readFile(join(cwd, 'package.json')));
  const packages: PackageEntry[] = Object.entries(declared)
    .map(([name, range]) => ({
      name,
      version: resolveInstalledVersion(readFile, cwd, name) ?? range,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let packageManager: string | undefined;
  let lockfileHash: string | undefined;
  for (const { file, manager } of LOCKFILES) {
    const content = readFile(join(cwd, file));
    if (content !== null) {
      packageManager = manager;
      lockfileHash = hash(content);
      break;
    }
  }

  const snapshotHash = hash(JSON.stringify({
    node_version: nodeVersion,
    package_manager: packageManager ?? null,
    packages,
  }));

  return {
    runtime: 'node',
    node_version: nodeVersion,
    ...(packageManager !== undefined ? { package_manager: packageManager } : {}),
    packages,
    ...(lockfileHash !== undefined ? { lockfile_hash: lockfileHash } : {}),
    snapshot_hash: snapshotHash,
    versions,
  };
}

function readDeclaredDeps(packageJson: string | null): Record<string, string> {
  if (!packageJson) return {};
  try {
    const pkg = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function resolveInstalledVersion(
  readFile: (p: string) => string | null,
  cwd: string,
  name: string,
): string | undefined {
  const content = readFile(join(cwd, 'node_modules', name, 'package.json'));
  if (!content) return undefined;
  try {
    const v = (JSON.parse(content) as { version?: string }).version;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}
