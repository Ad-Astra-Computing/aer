// Local state files for the Sentinel local-poll sensor, under
// $XDG_CONFIG_HOME/aer (default ~/.config/aer), following the same
// discipline apps/cli/src/auth/credentials-store.ts already uses:
// mode 0600, atomic write (temp file in the same directory, fsync, rename),
// and a symlink refusal at the target path (lstat before writing).

import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ObservationRow } from './types.js';

export class StateSymlinkError extends Error {
  constructor(path: string) {
    super(`refusing to use ${path}: it is a symlink`);
    this.name = 'StateSymlinkError';
  }
}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const configHome = xdg && xdg.trim() !== '' ? xdg : join(env['HOME'] ?? homedir(), '.config');
  return join(configHome, 'aer');
}

function assertNotSymlink(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return; // does not exist: nothing to refuse
  }
  if (stat.isSymbolicLink()) throw new StateSymlinkError(path);
}

function ensureDir(dir: string): void {
  assertNotSymlink(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Writes `contents` to `file` atomically: temp file in the same directory,
 * fsync'd, then renamed over the target. Refuses to write through a symlink
 * at the target path. */
export function atomicWriteFile(file: string, contents: string): void {
  const dir = join(file, '..');
  ensureDir(dir);
  assertNotSymlink(file);
  const tmp = join(dir, `.${file.split('/').pop()}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// --- device-id: shared across collectors, never deleted by uninstall ---

export function deviceIdPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), 'device-id');
}

/** Reads the existing device-id, or mints and persists a new one (shared
 * with any other collector that might read this same file). Never deleted by
 * `uninstall`. */
export function ensureDeviceId(env?: Record<string, string | undefined>): string {
  const file = deviceIdPath(env);
  assertNotSymlink(file);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const id = randomUUID();
  atomicWriteFile(file, id + '\n');
  return id;
}

/** Always mints and persists a NEW device id, overwriting any existing one.
 * Used only for `install --regenerate-device-id`, the remedy the server's
 * `device_already_registered` 409 explicitly tells a user to run when this
 * device id collides with a stale registration from a different machine. */
export function regenerateDeviceId(env?: Record<string, string | undefined>): string {
  const file = deviceIdPath(env);
  assertNotSymlink(file);
  const id = randomUUID();
  atomicWriteFile(file, id + '\n');
  return id;
}

// --- sentinel-local.json: install-time config (codexHome state, etc) ---

export interface SentinelLocalConfig {
  deviceId: string;
  consentVersion: string;
  installedAt: string;
  sourcePlatform: 'linux' | 'macos';
  /** The CODEX_HOME value captured from the installing shell, or one of the
   * documented reasons it could not be recorded (unset, relative, or unsafe
   * to escape into the unit/plist). Never a guess at the current shell's value. */
  codexHome: { kind: 'absolute'; value: string } | { kind: 'unset' } | { kind: 'not_checkable'; reason: string };
}

export function sentinelLocalConfigPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), 'sentinel-local.json');
}

export function readSentinelLocalConfig(env?: Record<string, string | undefined>): SentinelLocalConfig | undefined {
  const file = sentinelLocalConfigPath(env);
  assertNotSymlink(file);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SentinelLocalConfig;
  } catch {
    return undefined;
  }
}

export function writeSentinelLocalConfig(config: SentinelLocalConfig, env?: Record<string, string | undefined>): void {
  atomicWriteFile(sentinelLocalConfigPath(env), JSON.stringify(config, null, 2) + '\n');
}

export function deleteSentinelLocalConfig(env?: Record<string, string | undefined>): void {
  const file = sentinelLocalConfigPath(env);
  try {
    assertNotSymlink(file);
    rmSync(file, { force: true });
  } catch {
    /* best effort: uninstall must not fail just because this was already gone */
  }
}

// --- per-install key: used only to derive observation_id locally, never
// sent on the wire. Minted once at install time, deleted (and re-minted on
// the next install) by uninstall, same lifecycle as the push credential. ---

export function perInstallKeyPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), 'sentinel-local-key');
}

export function ensurePerInstallKey(env?: Record<string, string | undefined>): Buffer {
  const file = perInstallKeyPath(env);
  assertNotSymlink(file);
  if (existsSync(file)) {
    const hex = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  }
  const key = randomBytes(32);
  atomicWriteFile(file, key.toString('hex') + '\n');
  return key;
}

export function readPerInstallKey(env?: Record<string, string | undefined>): Buffer | undefined {
  const file = perInstallKeyPath(env);
  assertNotSymlink(file);
  if (!existsSync(file)) return undefined;
  const hex = readFileSync(file, 'utf8').trim();
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : undefined;
}

export function deletePerInstallKey(env?: Record<string, string | undefined>): void {
  const file = perInstallKeyPath(env);
  try {
    assertNotSymlink(file);
    rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

// --- push credential: deleted by uninstall ---

export interface PushCredential {
  sensorSourceId: string;
  pushToken: string;
  ingestUrl: string;
  // NOTE: no cached claim id here. The server never returns one on register
  // (the POST /v1/fleet/local-sensors response has no such field - only
  // GET /v1/fleet/sensors exposes `claim_id`, per row), and per spec §10.4 a
  // cached claim id would go stale across an admin reassignment: `uninstall
  // --erase` must fetch the CURRENT claim id at erase time, never reuse one
  // captured at install time.
}

export function pushCredentialPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), 'sentinel-local-push-credential.json');
}

export function readPushCredential(env?: Record<string, string | undefined>): PushCredential | undefined {
  const file = pushCredentialPath(env);
  assertNotSymlink(file);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PushCredential;
  } catch {
    return undefined;
  }
}

export function writePushCredential(cred: PushCredential, env?: Record<string, string | undefined>): void {
  atomicWriteFile(pushCredentialPath(env), JSON.stringify(cred, null, 2) + '\n');
}

export function deletePushCredential(env?: Record<string, string | undefined>): void {
  const file = pushCredentialPath(env);
  try {
    assertNotSymlink(file);
    rmSync(file, { force: true });
  } catch {
    /* best effort: uninstall must not fail just because this was already gone */
  }
}

// --- outbox: append-only queue of not-yet-pushed observation rows ---

export interface Outbox {
  rows: ObservationRow[];
  droppedCount: number;
}

const OUTBOX_CAP = 500;

export function outboxPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), 'sentinel-local-outbox.json');
}

export function readOutbox(env?: Record<string, string | undefined>): Outbox {
  const file = outboxPath(env);
  assertNotSymlink(file);
  if (!existsSync(file)) return { rows: [], droppedCount: 0 };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Outbox;
    return { rows: parsed.rows ?? [], droppedCount: parsed.droppedCount ?? 0 };
  } catch {
    return { rows: [], droppedCount: 0 };
  }
}

export function writeOutbox(outbox: Outbox, env?: Record<string, string | undefined>): void {
  atomicWriteFile(outboxPath(env), JSON.stringify(outbox, null, 2) + '\n');
}

/** Appends new rows to the outbox, dropping the OLDEST entries first past
 * OUTBOX_CAP, incrementing a visible dropped-count `status` can report. */
export function appendToOutbox(newRows: ObservationRow[], env?: Record<string, string | undefined>): Outbox {
  const outbox = readOutbox(env);
  outbox.rows.push(...newRows);
  if (outbox.rows.length > OUTBOX_CAP) {
    const excess = outbox.rows.length - OUTBOX_CAP;
    outbox.rows.splice(0, excess);
    outbox.droppedCount += excess;
  }
  writeOutbox(outbox, env);
  return outbox;
}

/** Removes the first `count` rows (the ones that just pushed successfully). */
export function removeFromOutboxFront(count: number, env?: Record<string, string | undefined>): Outbox {
  const outbox = readOutbox(env);
  outbox.rows.splice(0, count);
  writeOutbox(outbox, env);
  return outbox;
}

/** Removes the first `count` rows AND counts them as dropped (never silently
 * discarded) - for a whole-batch-rejected push (server 400: the envelope
 * itself was malformed) that retrying can never fix. */
export function dropFromOutboxFront(count: number, env?: Record<string, string | undefined>): Outbox {
  const outbox = readOutbox(env);
  const removed = outbox.rows.splice(0, count);
  outbox.droppedCount += removed.length;
  writeOutbox(outbox, env);
  return outbox;
}

export function deleteOutbox(env?: Record<string, string | undefined>): void {
  const file = outboxPath(env);
  try {
    assertNotSymlink(file);
    rmSync(file, { force: true });
  } catch {
    /* best effort: uninstall must not fail just because this was already gone */
  }
}

export { OUTBOX_CAP };
