// Transport patch installer: turns the configured transport names into installed
// patches and reports which are active (for the collector.report coverage block).
// http + https are covered by one installer but reported under both names.

import type { CollectorEvent } from '../session.js';
import type { Attestor } from '../attestor.js';
import { installFetchPatch } from './fetch.js';
import { installHttpPatch } from './http.js';
import { installChildProcessPatch } from './child-process.js';

type Capture = (event: CollectorEvent) => void;

export interface InstalledPatches {
  /** Names of active patches (e.g. ['fetch','http','https','child_process']). */
  enabled: string[];
  /** Tear down every installed patch. Never throws. */
  uninstall: () => void;
}

export function installTransportPatches(
  capture: Capture,
  transportNames: string[],
  attestor?: Attestor,
): InstalledPatches {
  const want = new Set(transportNames);
  const enabled: string[] = [];
  const uninstalls: Array<() => void> = [];

  if (want.has('fetch')) {
    uninstalls.push(installFetchPatch(capture, attestor));
    enabled.push('fetch');
  }
  // node:http + node:https share one installer.
  if (want.has('http') || want.has('https')) {
    uninstalls.push(installHttpPatch(capture, attestor));
    if (want.has('http')) enabled.push('http');
    if (want.has('https')) enabled.push('https');
  }
  if (want.has('child_process')) {
    uninstalls.push(installChildProcessPatch(capture));
    enabled.push('child_process');
  }

  return {
    enabled,
    uninstall: () => {
      for (const u of uninstalls) {
        try { u(); } catch { /* best-effort teardown */ }
      }
    },
  };
}
