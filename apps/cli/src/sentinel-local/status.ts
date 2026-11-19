import { existsSync } from 'node:fs';
import { readSentinelLocalConfig, readOutbox, readPushCredential, deviceIdPath } from './state.js';
import { detectSourcePlatform, controllerFor, systemdUnitPath, launchdPlistPath, type ExecFn, type SourcePlatform } from './platform-process.js';

export interface StatusReport {
  installed: boolean;
  unitExists: boolean;
  daemonActive: boolean | undefined;
  deviceId: string | undefined;
  sensorSourceId: string | undefined;
  outboxDepth: number;
  droppedCount: number;
  codexHome:
    | { recorded: 'unset' | 'not_checkable' | 'absolute'; recordedValue?: string; current: string | undefined; stale: boolean }
    | undefined;
}

export interface StatusOptions {
  execFn: ExecFn;
  env?: Record<string, string | undefined>;
  platform?: SourcePlatform;
}

export async function runStatus(opts: StatusOptions): Promise<StatusReport> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  const config = readSentinelLocalConfig(env);
  const credential = readPushCredential(env);
  const outbox = readOutbox(env);

  const unitPath = platform === 'linux' ? systemdUnitPath(env) : platform === 'macos' ? launchdPlistPath(env) : undefined;
  const unitExists = unitPath ? existsSync(unitPath) : false;

  let daemonActive: boolean | undefined;
  if (platform && unitExists) {
    try {
      daemonActive = await controllerFor(platform, opts.execFn, env).isActive();
    } catch {
      daemonActive = false;
    }
  } else if (platform) {
    daemonActive = false; // missing/broken unit file: clearly not active
  }

  let codexHome: StatusReport['codexHome'];
  if (config) {
    const current = env['CODEX_HOME'];
    const recorded = config.codexHome;
    const stale = recorded.kind === 'absolute' ? current !== recorded.value : current !== undefined && recorded.kind === 'unset';
    codexHome = {
      recorded: recorded.kind,
      ...(recorded.kind === 'absolute' ? { recordedValue: recorded.value } : {}),
      current,
      stale,
    };
  }

  return {
    installed: config !== undefined,
    unitExists,
    daemonActive,
    deviceId: config?.deviceId ?? (existsSync(deviceIdPath(env)) ? 'present' : undefined),
    sensorSourceId: credential?.sensorSourceId,
    outboxDepth: outbox.rows.length,
    droppedCount: outbox.droppedCount,
    codexHome,
  };
}
