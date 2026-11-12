import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureDeviceId,
  regenerateDeviceId,
  ensurePerInstallKey,
  writeSentinelLocalConfig,
  writePushCredential,
  readSentinelLocalConfig,
  atomicWriteFile,
} from './state.js';
import { captureCodexHome, CodexHomeUnsafeError } from './codex-home-capture.js';
import { buildSystemdUnit } from './systemd-unit.js';
import { buildLaunchdAgent } from './launchd-agent.js';
import { detectSourcePlatform, systemdUnitPath, launchdPlistPath, controllerFor, type ExecFn, type SourcePlatform } from './platform-process.js';
import type { SentinelLocalApiClient } from './http-client.js';

// Must match fleet-local-sensors.ts's CONSENT_VERSION exactly, or the server
// 400s with `consent_version_outdated`.
export const CONSENT_VERSION = 'v1';

export interface InstallOptions {
  apiClient: SentinelLocalApiClient;
  execFn: ExecFn;
  env?: Record<string, string | undefined>;
  environmentId?: string;
  deviceLabel?: string;
  /** Defaults to process.execPath/the running CLI's own absolute entry
   * script - overridable so tests never depend on the real executable. */
  execPath?: string;
  scriptPath?: string;
  platform?: SourcePlatform;
  print?: (line: string) => void;
  /** Per spec §10.1: the caller (main.ts) must have already obtained either
   * an interactive "yes" confirmation to the local-monitoring disclosure, or
   * an explicit `--i-understand-local-monitoring` flag for non-interactive
   * use. `runInstall` never prompts itself and never proceeds without this. */
  consentAcknowledged: boolean;
  /** `install --regenerate-device-id`: mints a fresh device id instead of
   * reusing the persisted one - the remedy fleet-local-sensors.ts's
   * `device_already_registered` 409 tells a user to run when this device id
   * collides with a stale registration from a different machine. */
  regenerateDeviceId?: boolean;
}

export interface InstallResult {
  deviceId: string;
  sensorSourceId: string;
  unitOrPlistPath: string;
}

/** Resolves the bundled entry point's own absolute path from a module's
 * `import.meta.url`. The published package ships exactly one bundled file,
 * `dist/main.js` (built from src/bin.ts by bundle.mjs) - every source module,
 * including this one, is inlined into it. At runtime this module's own
 * `import.meta.url` IS main.js's url (there is no separate
 * dist/sentinel-local/install.js to be "one level below"), so the unit/plist
 * must point at the sibling `main.js` next to it, never a directory above. */
export function resolveScriptPathFromMetaUrl(metaUrl: string): string {
  const here = dirname(fileURLToPath(metaUrl));
  return join(here, 'main.js');
}

function resolveScriptPath(): string {
  return resolveScriptPathFromMetaUrl(import.meta.url);
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  if (!platform) throw new Error('sentinel-local is only supported on Linux and macOS');

  if (!opts.consentAcknowledged) {
    throw new Error(
      'install aborted: local-monitoring consent was not confirmed. Re-run interactively and ' +
      "confirm the disclosure, or pass --i-understand-local-monitoring for non-interactive use.",
    );
  }

  // H6: never silently re-register a device that already has a local
  // install - that would orphan the existing credential/unit and could mint
  // a second server-side registration for no reason.
  const existing = readSentinelLocalConfig(env);
  if (existing) {
    throw new Error('sentinel-local is already installed on this device. Run `aer sentinel-local uninstall` first.');
  }

  const deviceId = opts.regenerateDeviceId ? regenerateDeviceId(env) : ensureDeviceId(env);
  ensurePerInstallKey(env);

  let codexHome;
  try {
    codexHome = captureCodexHome(env);
  } catch (err) {
    if (err instanceof CodexHomeUnsafeError) {
      throw new Error(`install aborted: ${err.message}. Unset CODEX_HOME or fix its value and re-run install.`);
    }
    throw err;
  }

  const registration = await opts.apiClient.register({
    device_id: deviceId,
    consent_version: CONSENT_VERSION,
    source_platform: platform,
    ...(opts.environmentId !== undefined ? { environment_id: opts.environmentId } : {}),
    ...(opts.deviceLabel !== undefined ? { device_label: opts.deviceLabel } : {}),
  });

  // H6: registration has now happened server-side. Any failure from here on
  // must roll it back (disable it) rather than leave an orphaned server-side
  // registration with no local credential ever able to reach it.
  try {
    writePushCredential(
      {
        sensorSourceId: registration.sensor_source_id,
        pushToken: registration.push_token,
        ingestUrl: registration.ingest_url,
      },
      env,
    );

    const execPath = opts.execPath ?? process.execPath;
    const scriptPath = opts.scriptPath ?? resolveScriptPath();

    let unitOrPlistPath: string;
    let recordedCodexHome;
    if (platform === 'linux') {
      const { unit, recordedCodexHome: recorded } = buildSystemdUnit({ execPath, scriptPath, codexHome });
      recordedCodexHome = recorded;
      unitOrPlistPath = systemdUnitPath(env);
      atomicWriteFile(unitOrPlistPath, unit);
    } else {
      const { plist, recordedCodexHome: recorded } = buildLaunchdAgent({ execPath, scriptPath, codexHome });
      recordedCodexHome = recorded;
      unitOrPlistPath = launchdPlistPath(env);
      atomicWriteFile(unitOrPlistPath, plist);
    }

    writeSentinelLocalConfig(
      {
        deviceId,
        consentVersion: CONSENT_VERSION,
        installedAt: new Date().toISOString(),
        sourcePlatform: platform,
        codexHome: recordedCodexHome,
      },
      env,
    );

    const controller = controllerFor(platform, opts.execFn, env);
    await controller.enableAndStart();

    print(`Registered device ${deviceId} as sensor ${registration.sensor_source_id}.`);
    print(`Installed and started the local-poll daemon (${unitOrPlistPath}).`);
    if (recordedCodexHome.kind === 'not_checkable') {
      print(`Note: CODEX_HOME could not be recorded (${recordedCodexHome.kind === 'not_checkable' ? recordedCodexHome.reason : ''}); Codex instrumentation will report not_checkable.`);
    }

    return { deviceId, sensorSourceId: registration.sensor_source_id, unitOrPlistPath };
  } catch (err) {
    try {
      await opts.apiClient.disable(registration.sensor_source_id);
    } catch {
      // Best effort: the local failure is the one the caller needs to see;
      // a failed rollback attempt must not mask it.
    }
    throw err;
  }
}

export function readInstalledConfig(env?: Record<string, string | undefined>) {
  return readSentinelLocalConfig(env);
}
