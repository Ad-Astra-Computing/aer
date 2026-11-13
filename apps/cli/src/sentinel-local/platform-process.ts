// Thin, injectable wrapper around systemd --user / launchd process control,
// so install/uninstall/pause/resume/status never shell out directly and can
// be unit-tested with a fake exec function.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { UNIT_NAME } from './systemd-unit.js';
import { LABEL as LAUNCHD_LABEL } from './launchd-agent.js';

export type SourcePlatform = 'linux' | 'macos';

export function detectSourcePlatform(platform: NodeJS.Platform = process.platform): SourcePlatform | undefined {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  return undefined;
}

export interface ExecFn {
  (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function systemdUnitPath(env?: Record<string, string | undefined>): string {
  const home = env?.['HOME'] ?? homedir();
  return join(home, '.config', 'systemd', 'user', UNIT_NAME);
}

export function launchdPlistPath(env?: Record<string, string | undefined>): string {
  const home = env?.['HOME'] ?? homedir();
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export interface ProcessController {
  /** Enables and starts the daemon (install). */
  enableAndStart(): Promise<void>;
  /** Local-only stop (pause). Never touches the server's `enabled` column. */
  stop(): Promise<void>;
  /** Local-only start (resume), after a prior pause. */
  start(): Promise<void>;
  /** Disables and stops the daemon entirely (uninstall). */
  disableAndStop(): Promise<void>;
  /** Whether the daemon unit is currently active. */
  isActive(): Promise<boolean>;
}

// B1: `ExecFn` never throws for a plain nonzero exit (systemctl/launchctl
// failing is ordinary, not an exceptional subprocess-launch failure) - every
// mutating call that must actually succeed has to check `code` itself and
// throw a sanitized error carrying the relevant stderr, or install/pause/
// resume silently "succeed" with no daemon actually running.
function assertExecOk(cmd: string, args: string[], result: { code: number; stderr: string }): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.code}${detail.length > 0 ? `: ${detail}` : ''}`,
    );
  }
}

export class SystemdUserController implements ProcessController {
  constructor(private readonly execFn: ExecFn) {}

  async enableAndStart(): Promise<void> {
    const reload = await this.execFn('systemctl', ['--user', 'daemon-reload']);
    assertExecOk('systemctl', ['--user', 'daemon-reload'], reload);
    const args = ['--user', 'enable', '--now', UNIT_NAME];
    const enable = await this.execFn('systemctl', args);
    assertExecOk('systemctl', args, enable);
  }
  async stop(): Promise<void> {
    const args = ['--user', 'stop', UNIT_NAME];
    const result = await this.execFn('systemctl', args);
    assertExecOk('systemctl', args, result);
  }
  async start(): Promise<void> {
    const args = ['--user', 'start', UNIT_NAME];
    const result = await this.execFn('systemctl', args);
    assertExecOk('systemctl', args, result);
  }
  async disableAndStop(): Promise<void> {
    // Best-effort: uninstall must proceed even when there is no unit to
    // disable, so this one intentionally never throws on a nonzero exit.
    await this.execFn('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  }
  async isActive(): Promise<boolean> {
    const result = await this.execFn('systemctl', ['--user', 'is-active', UNIT_NAME]);
    return result.stdout.trim() === 'active';
  }
}

export class LaunchdUserController implements ProcessController {
  constructor(private readonly execFn: ExecFn, private readonly plistPath: string) {}

  private uidGuiDomain(): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return `gui/${uid}`;
  }

  async enableAndStart(): Promise<void> {
    const args = ['bootstrap', this.uidGuiDomain(), this.plistPath];
    const result = await this.execFn('launchctl', args);
    assertExecOk('launchctl', args, result);
  }
  async stop(): Promise<void> {
    const args = ['bootout', `${this.uidGuiDomain()}/${LAUNCHD_LABEL}`];
    const result = await this.execFn('launchctl', args);
    assertExecOk('launchctl', args, result);
  }
  async start(): Promise<void> {
    const args = ['bootstrap', this.uidGuiDomain(), this.plistPath];
    const result = await this.execFn('launchctl', args);
    assertExecOk('launchctl', args, result);
  }
  async disableAndStop(): Promise<void> {
    // Best-effort: uninstall must proceed even when there is no service to
    // disable, so this one intentionally never throws on a nonzero exit.
    await this.execFn('launchctl', ['bootout', `${this.uidGuiDomain()}/${LAUNCHD_LABEL}`]);
  }
  async isActive(): Promise<boolean> {
    const result = await this.execFn('launchctl', ['list', LAUNCHD_LABEL]);
    return result.code === 0;
  }
}

export function controllerFor(platform: SourcePlatform, execFn: ExecFn, env?: Record<string, string | undefined>): ProcessController {
  return platform === 'linux' ? new SystemdUserController(execFn) : new LaunchdUserController(execFn, launchdPlistPath(env));
}
