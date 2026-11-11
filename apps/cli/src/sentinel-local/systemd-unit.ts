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
    `ExecStart=${opts.execPath} ${opts.scriptPath} sentinel-local run-daemon`,
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
