import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureDeviceId,
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

export const CONSENT_VERSION = 'sentinel-local-consent-v1';

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
}

export interface InstallResult {
  deviceId: string;
  sensorSourceId: string;
  unitOrPlistPath: string;
}

function resolveScriptPath(): string {
  // This file lives at apps/cli/dist/sentinel-local/install.js once built;
  // the generated unit/plist must point at the built entry point, not this
  // source file, so the daemon invocation matches how `aer` itself is run.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'main.js');
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  if (!platform) throw new Error('sentinel-local is only supported on Linux and macOS');

  const deviceId = ensureDeviceId(env);
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

  writePushCredential(
    {
      sensorSourceId: registration.sensor_source_id,
      pushToken: registration.push_token,
      ingestUrl: registration.ingest_url,
      expectedClaimId: registration.expected_claim_id,
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
}

export function readInstalledConfig(env?: Record<string, string | undefined>) {
  return readSentinelLocalConfig(env);
}
