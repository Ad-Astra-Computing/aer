// Generates the launchd user agent plist for the Sentinel local-poll daemon,
// via the real plist/XML serializer (plist.ts), never string concatenation.

import { serializePlist, type PlistValue } from './plist.js';
import type { CodexHomeCapture } from './codex-home-capture.js';

export const LABEL = 'run.aer.sentinel-local';

export interface LaunchdAgentOptions {
  execPath: string;
  scriptPath: string;
  codexHome: CodexHomeCapture;
}

export function buildLaunchdAgent(opts: LaunchdAgentOptions): { plist: string; recordedCodexHome: CodexHomeCapture } {
  const root: Record<string, PlistValue> = {
    Label: LABEL,
    ProgramArguments: [opts.execPath, opts.scriptPath, 'sentinel-local', 'run-daemon'],
    RunAtLoad: true,
    KeepAlive: true,
  };

  // launchd's plist is XML, so any value - including one containing `&`,
  // `<`, `>` or a quote - is escaped automatically by the serializer. There
  // is no "cannot be escaped" case here (unlike systemd's quoted-assignment
  // restriction), so a well-formed absolute CODEX_HOME always makes it in.
  let recordedCodexHome = opts.codexHome;
  if (opts.codexHome.kind === 'absolute') {
    root['EnvironmentVariables'] = { CODEX_HOME: opts.codexHome.value };
  }

  return { plist: serializePlist(root), recordedCodexHome };
}
