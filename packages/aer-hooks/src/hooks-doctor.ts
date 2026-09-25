// ADR-023 B3: the `staleRegistrations()` entry point `aer doctor` calls.
// Kept out of install-cli.ts, which self-invokes when run directly: bundled
// into another CLI, that guard can no longer tell the two entry points apart.

import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import * as path from 'node:path';
import { status } from './install.js';
import { diagnoseRegistrations, diagnoseVersion, diagnoseNixShadow, type StaleRegistration } from './doctor.js';
import { HOOKS_VERSION } from './evidence.js';

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version an `aer-hook` on PATH reports, or undefined when it cannot be
 * run at all. Best-effort: a doctor check must never throw or hang the CLI.
 * A binary old enough to print NOTHING for --version (0.1.x) still ran
 * successfully, so it is reported as '0.0.0' - definitely stale - rather
 * than treated the same as "could not run it at all".
 */
function installedAerHookVersion(dir: string): string | undefined {
  try {
    const out = execFileSync(path.join(dir, 'aer-hook'), ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
    return out.length > 0 ? out : '0.0.0';
  } catch {
    return undefined;
  }
}

/** ADR-023 B3: registrations lacking --lifecycle v2, an outdated aer-hooks, or a nix-profile shadow. */
export async function staleRegistrations(opts: { dir?: string } = {}): Promise<StaleRegistration[]> {
  const entries = await status(opts);
  const findings = diagnoseRegistrations(entries);

  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const hasAerHook = (d: string): boolean => isExecutable(path.join(d, 'aer-hook'));
  const firstDir = pathDirs.find(hasAerHook);
  if (firstDir !== undefined) {
    const installedVersion = installedAerHookVersion(firstDir);
    const versionFinding = diagnoseVersion(installedVersion, HOOKS_VERSION);
    if (versionFinding !== undefined) findings.push(versionFinding);
  }
  const projectBinDir = path.join(process.cwd(), 'node_modules', '.bin');
  const nixFinding = diagnoseNixShadow(pathDirs, hasAerHook, projectBinDir);
  if (nixFinding !== undefined) findings.push(nixFinding);

  return findings;
}
