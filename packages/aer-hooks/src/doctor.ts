// ADR-023 B3: staleness checks for `aer doctor` / `aer-hooks status --json`.
//
// Each check is a pure function over already-gathered facts (wired commands,
// PATH entries, versions), so the harder-to-fake parts (spawning a binary,
// reading real env/PATH) stay thin call sites elsewhere and this stays fully
// unit-testable.

import type { Harness } from './install.js';
import type { StatusEntry } from './install.js';

export type StaleReason = 'missing_lifecycle_v2' | 'outdated_collector' | 'nix_profile_shadow';

export interface StaleRegistration {
  harness: Harness | 'any';
  reason: StaleReason;
  detail: string;
  /** The exact command to run to fix it. */
  fix: string;
}

// Root-session join (ADR-023 B1) reads the hook process's own environment at
// runtime (CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID) rather than a flag the
// installer writes, so there is nothing in the wired COMMAND text to check
// for it; a stale registration here is only about --lifecycle.
const LIFECYCLE_V2_RE = /--lifecycle[= ]v2/;

/** A registered command missing --lifecycle v2 (either `--lifecycle v2` or `--lifecycle=v2`). */
export function diagnoseCommand(harness: Harness, command: string): StaleRegistration[] {
  if (LIFECYCLE_V2_RE.test(command)) return [];
  return [
    {
      harness,
      reason: 'missing_lifecycle_v2',
      detail: `the ${harness} hook command has no --lifecycle v2, so Stop still completes the record on every turn`,
      fix: `aer-hooks install ${harness}`,
    },
  ];
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

// The release that shipped the B1 fix this changeset carries (env-based
// root-session join, the budget/livelock fix, pid-alias identity). Bundling
// aer-hooks into a consumer's own single-file build can leave the runtime
// HOOKS_VERSION reading the CONSUMER's manifest instead (see evidence.ts),
// so a stale-version check clamps to at least this floor rather than trust a
// possibly-wrong "current" number blindly.
export const MIN_HOOKS_VERSION_FOR_B1 = '0.4.0';

/**
 * An installed aer-hooks release older than the one running `aer doctor`, or
 * a release too old to say what it is at all.
 *
 * `wired` is whether some harness config actually references the binary
 * (from `diagnoseRegistrations`' own definition: an entry with wiredEvents).
 * A binary merely found on PATH with nothing pointing at it is not "wired",
 * and saying so would blame a harness config that never touches it.
 */
export function diagnoseVersion(
  installedVersion: string | undefined,
  currentVersion: string,
  opts: { wired: boolean } = { wired: true },
): StaleRegistration | undefined {
  if (installedVersion === undefined || installedVersion === 'unknown') return undefined;
  const effectiveCurrent = isOlderVersion(currentVersion, MIN_HOOKS_VERSION_FOR_B1) ? MIN_HOOKS_VERSION_FOR_B1 : currentVersion;
  const subject = opts.wired ? 'the wired aer-hooks' : 'the aer-hooks on PATH';
  const fix = 'pnpm add -D @adastracomputing/aer-hooks@latest && aer-hooks install claude-code';
  if (installedVersion === 'unreadable') {
    return {
      harness: 'any',
      reason: 'outdated_collector',
      detail: `could not read the version of ${subject}, so it is probably older than ${effectiveCurrent}`,
      fix,
    };
  }
  if (!isOlderVersion(installedVersion, effectiveCurrent)) return undefined;
  return {
    harness: 'any',
    reason: 'outdated_collector',
    detail: `${subject} is ${installedVersion}, older than ${effectiveCurrent}`,
    fix,
  };
}

const NIX_PROFILE_MARKERS = ['/nix/store/', '/.nix-profile/', '/nix/var/nix/profiles/'];

/**
 * The nix-profile-shadow check (ADR-023 B3): a global `aer-hook` on PATH,
 * resolved ahead of the project's own install, that can be older than what
 * the project just installed and silently records with it instead.
 *
 * Only warns when the project actually HAS its own install to be shadowed
 * (`projectBinDir` holds an `aer-hook`): a nix-profile install with no
 * project install nearby is a legitimate, working setup on its own, not a
 * shadow of anything.
 */
export function diagnoseNixShadow(
  pathDirs: string[],
  hasAerHook: (dir: string) => boolean,
  projectBinDir: string | undefined,
): StaleRegistration | undefined {
  if (projectBinDir === undefined || !hasAerHook(projectBinDir)) return undefined;
  const dir = pathDirs.find(hasAerHook);
  if (dir === undefined || dir === projectBinDir) return undefined;
  if (!NIX_PROFILE_MARKERS.some((m) => dir.includes(m))) return undefined;
  return {
    harness: 'any',
    reason: 'nix_profile_shadow',
    detail: `aer-hook on PATH resolves to a nix profile copy at ${dir}, ahead of the project's own install at ${projectBinDir}`,
    fix: 'nix profile upgrade aer-hooks (or remove it from the profile and rely on the project install)',
  };
}
