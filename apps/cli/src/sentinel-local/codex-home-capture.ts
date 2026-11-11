// Captures CODEX_HOME at install time, from the installing shell: the
// daemon's own CODEX_HOME belongs to systemd/launchd, not the developer's
// interactive shell (design doc's v6 fix, §3.4/§8.3/§12). A relative value
// cannot be resolved into one file -> not_checkable; a control character or
// newline could corrupt the generated unit/plist -> install fails outright;
// a double quote under systemd is refused rather than escaped.

import { isAbsolute } from 'node:path';

export type CodexHomeCapture =
  | { kind: 'unset' }
  | { kind: 'absolute'; value: string }
  | { kind: 'not_checkable'; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE_RE = /[\x00-\x1f\x7f]/;

export class CodexHomeUnsafeError extends Error {
  constructor(public readonly reason: string) {
    super(`refusing to write CODEX_HOME into the unit/plist: ${reason}`);
    this.name = 'CodexHomeUnsafeError';
  }
}

// Captures CODEX_HOME from the installing shell. Never throws for "unset" or
// "relative" - honest, expected states. Throws CodexHomeUnsafeError only for
// an absolute value containing something unsafe to write (control
// char/newline): install should fail loudly rather than degrade silently.
export function captureCodexHome(env: Record<string, string | undefined>): CodexHomeCapture {
  const raw = env['CODEX_HOME'];
  if (raw === undefined || raw.length === 0) return { kind: 'unset' };
  if (CONTROL_OR_NEWLINE_RE.test(raw)) {
    throw new CodexHomeUnsafeError(`CODEX_HOME contains a control character or newline: ${JSON.stringify(raw)}`);
  }
  if (!isAbsolute(raw)) return { kind: 'not_checkable', reason: 'CODEX_HOME is relative; Codex resolves it against its own, varying cwd' };
  return { kind: 'absolute', value: raw };
}

// Escapes an absolute CODEX_HOME value for a systemd `Environment=` line:
// every literal `%` doubled to `%%`. A double quote is refused outright
// (returns undefined); the caller records `not_checkable` for that case.
export function escapeForSystemdEnvironmentLine(value: string): string | undefined {
  if (value.includes('"')) return undefined;
  return value.replace(/%/g, '%%');
}

/** Builds the full `Environment="CODEX_HOME=<value>"` line, or undefined if
 * the value cannot be safely escaped (caller falls back to not_checkable). */
export function systemdCodexHomeEnvironmentLine(value: string): string | undefined {
  const escaped = escapeForSystemdEnvironmentLine(value);
  if (escaped === undefined) return undefined;
  return `Environment="CODEX_HOME=${escaped}"`;
}
