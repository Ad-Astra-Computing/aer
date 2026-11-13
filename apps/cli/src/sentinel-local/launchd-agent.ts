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
    // SuccessfulExit:false, never a bare `true`: a bare true relaunches on
    // ANY exit, including the daemon's own deliberate clean exit(0) when
    // runDaemonForever halts on a 401/403 (the credential is revoked or the
    // sensor disabled) - that would crash-loop forever, each loop making
    // one more unauthenticated push attempt against the real API. This is
    // launchd's equivalent of systemd's Restart=on-failure.
    KeepAlive: { SuccessfulExit: false },
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
