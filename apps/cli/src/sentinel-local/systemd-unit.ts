// Generates the systemd user unit for the Sentinel local-poll daemon.
// Absolute `process.execPath` + absolute script path are recorded at install
// time, not re-resolved at every daemon start: a later Node upgrade or a
// different PATH at boot must not break the unit.

import { systemdCodexHomeEnvironmentLine } from './codex-home-capture.js';
import type { CodexHomeCapture } from './codex-home-capture.js';

export const UNIT_NAME = 'aer-sentinel-local.service';

export interface SystemdUnitOptions {
  execPath: string;
  scriptPath: string;
  codexHome: CodexHomeCapture;
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE_RE = /[\x00-\x1f\x7f]/;
const NEEDS_QUOTING_RE = /[\s"\\]/;

export class SystemdExecArgUnsafeError extends Error {
  constructor(public readonly reason: string) {
    super(`refusing to write an ExecStart= argument: ${reason}`);
    this.name = 'SystemdExecArgUnsafeError';
  }
}

/** Escapes one argument for a systemd `ExecStart=` line (systemd.service's
 * "Command Lines" grammar): every literal `%` doubled (specifier expansion),
 * every literal `$` doubled (systemd's own independent `$VAR`/`${VAR}`
 * environment-variable expansion on the ExecStart= line - otherwise a path
 * containing a literal `$` could be rewritten by variable substitution, or
 * erased entirely if the referenced variable is unset), and an argument
 * containing whitespace, a backslash, or a double quote is wrapped in double
 * quotes with its own backslashes and quotes escaped (systemd's quoting is
 * C-style inside `"..."`). A control character or a raw newline is refused
 * outright - never silently mis-escaped - since a newline could inject an
 * entirely separate directive into the unit file. */
export function escapeSystemdExecArg(value: string): string {
  if (CONTROL_OR_NEWLINE_RE.test(value)) {
    throw new SystemdExecArgUnsafeError(`argument contains a control character or newline: ${JSON.stringify(value)}`);
  }
  const specifiersDoubled = value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (!NEEDS_QUOTING_RE.test(specifiersDoubled)) return specifiersDoubled;
  const escaped = specifiersDoubled.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Returns the unit file contents, plus the (possibly revised) CodexHomeCapture
 * actually safe to persist in sentinel-local.json: a capture that could not
 * be escaped into the unit (double-quote case) downgrades to not_checkable
 * here, never written into the file half-escaped. */
export function buildSystemdUnit(opts: SystemdUnitOptions): { unit: string; recordedCodexHome: CodexHomeCapture } {
  const lines = [
    '[Unit]',
    'Description=AER Sentinel local-poll sensor',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[escapeSystemdExecArg(opts.execPath), escapeSystemdExecArg(opts.scriptPath), 'sentinel-local', 'run-daemon'].join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
  ];

  let recordedCodexHome = opts.codexHome;
  if (opts.codexHome.kind === 'absolute') {
    const envLine = systemdCodexHomeEnvironmentLine(opts.codexHome.value);
    if (envLine !== undefined) {
      lines.push(envLine);
    } else {
      recordedCodexHome = {
        kind: 'not_checkable',
        reason: 'CODEX_HOME contains a double quote, which cannot be safely escaped into a systemd Environment= line',
      };
    }
  }

  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return { unit: lines.join('\n'), recordedCodexHome };
}
