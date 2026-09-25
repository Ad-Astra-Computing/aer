// ADR-023 B3: staleness checks for `aer doctor` / `aer-hooks status --json`.
//
// Each check is a pure function over already-gathered facts (wired commands,
// PATH entries, versions), so the harder-to-fake parts (spawning a binary,
// reading real env/PATH) stay thin call sites elsewhere and this stays fully
// unit-testable.

import type { Harness } from './install.js';
import type { StatusEntry } from './install.js';

export type StaleReason = 'missing_lifecycle_v2' | 'missing_root_session' | 'outdated_collector' | 'nix_profile_shadow';

export interface StaleRegistration {
  harness: Harness | 'any';
  reason: StaleReason;
  detail: string;
  /** The exact command to run to fix it. */
  fix: string;
}

/** A registered command missing --lifecycle v2 or (Claude Code) --root-session. */
export function diagnoseCommand(harness: Harness, command: string): StaleRegistration[] {
  const out: StaleRegistration[] = [];
  if (!command.includes('--lifecycle v2')) {
    out.push({
      harness,
      reason: 'missing_lifecycle_v2',
      detail: `the ${harness} hook command has no --lifecycle v2, so Stop still completes the record on every turn`,
      fix: `aer-hooks install ${harness}`,
    });
  }
  if (harness === 'claude-code' && !command.includes('--root-session')) {
    out.push({
      harness,
      reason: 'missing_root_session',
      detail: 'the claude-code hook command has no --root-session, so a subagent tool call opens its own record instead of joining the lead',
      fix: 'aer-hooks install claude-code',
    });
  }
  return out;
}

/** Every stale-command finding across a `status()` listing, deduplicated per harness+reason. */
export function diagnoseRegistrations(entries: StatusEntry[]): StaleRegistration[] {
  const out: StaleRegistration[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.wiredEvents.length === 0) continue;
    for (const command of entry.commands) {
      for (const finding of diagnoseCommand(entry.harness, command)) {
        const key = `${finding.harness}:${finding.reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(finding);
      }
    }
  }
  return out;
}

/** true when `a` is strictly older than `b`, comparing dotted numeric versions. Non-numeric parts sort as 0. */
export function isOlderVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** An installed aer-hooks release older than the one running `aer doctor`. */
export function diagnoseVersion(installedVersion: string | undefined, currentVersion: string): StaleRegistration | undefined {
  if (installedVersion === undefined || installedVersion === 'unknown') return undefined;
  if (!isOlderVersion(installedVersion, currentVersion)) return undefined;
  return {
    harness: 'any',
    reason: 'outdated_collector',
    detail: `the wired aer-hooks is ${installedVersion}, older than the installed ${currentVersion}`,
    fix: 'pnpm add -D @adastracomputing/aer-hooks@latest && aer-hooks install claude-code',
  };
}

const NIX_PROFILE_MARKERS = ['/nix/store/', '/.nix-profile/', '/nix/var/nix/profiles/'];

/**
 * The nix-profile-shadow check (ADR-023 B3): a global `aer-hook` on PATH,
 * resolved ahead of the project's own install, that can be older than what
 * the project just installed and silently records with it instead.
 */
export function diagnoseNixShadow(
  pathDirs: string[],
  hasAerHook: (dir: string) => boolean,
  projectBinDir: string | undefined,
): StaleRegistration | undefined {
  const dir = pathDirs.find(hasAerHook);
  if (dir === undefined) return undefined;
  if (projectBinDir !== undefined && dir === projectBinDir) return undefined;
  if (!NIX_PROFILE_MARKERS.some((m) => dir.includes(m))) return undefined;
  return {
    harness: 'any',
    reason: 'nix_profile_shadow',
    detail: `aer-hook on PATH resolves to a nix profile copy at ${dir}, ahead of the project's own install`,
    fix: 'nix profile upgrade aer-hooks (or remove it from the profile and rely on the project install)',
  };
}
