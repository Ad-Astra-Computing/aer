// `$XDG_CONFIG_HOME/aer/credentials.json` (default `~/.config/aer/`), keyed by
// base URL. Same care as an SSH key: 0700/0600, atomic write, no symlinks.
// Callers are responsible for never printing `api_key`.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredCredential {
  tenant_id: string;
  api_key: string;
  key_id: string;
  role: string;
  expires_at: string;
}

export type CredentialsFile = Record<string, StoredCredential>;

export interface CredentialsPaths {
  dir: string;
  file: string;
}

export class CredentialsSymlinkError extends Error {
  constructor(path: string) {
    super(`refusing to use ${path}: it is a symlink`);
    this.name = 'CredentialsSymlinkError';
  }
}

/** Resolves the credentials directory + file path, honoring XDG_CONFIG_HOME. */
export function credentialsPaths(env: Record<string, string | undefined> = process.env): CredentialsPaths {
  const xdg = env['XDG_CONFIG_HOME'];
  const configHome = xdg && xdg.trim() !== '' ? xdg : join(env['HOME'] ?? homedir(), '.config');
  const dir = join(configHome, 'aer');
  return { dir, file: join(dir, 'credentials.json') };
}

/** Strips a trailing slash so the same origin always maps to the same key. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function assertNotSymlink(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return; // does not exist: nothing to refuse
  }
  if (stat.isSymbolicLink()) throw new CredentialsSymlinkError(path);
}

/** Reads the whole credentials file. Missing file reads as empty, never an error. */
export function readCredentialsFile(paths: CredentialsPaths): CredentialsFile {
  assertNotSymlink(paths.dir);
  if (!existsSync(paths.file)) return {};
  assertNotSymlink(paths.file);
  let raw: string;
  try {
    raw = readFileSync(paths.file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CredentialsFile) : {};
  } catch {
    return {};
  }
}

/**
 * Writes the whole credentials file atomically: a temp file in the same
 * directory, written 0600, then renamed over the target. A rename within one
 * directory is atomic on every OS this CLI supports, so a reader never sees a
 * half-written file.
 */
export function writeCredentialsFile(paths: CredentialsPaths, data: CredentialsFile): void {
  assertNotSymlink(paths.dir);
  if (!existsSync(paths.dir)) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(paths.dir, 0o700); // mkdir's mode is filtered by umask; make it explicit
  assertNotSymlink(paths.file);

  const tmpFile = join(paths.dir, `.credentials.json.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmpFile, 0o600); // same reasoning as the directory above
    renameSync(tmpFile, paths.file);
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

export function getCredential(baseUrl: string, env?: Record<string, string | undefined>): StoredCredential | undefined {
  const paths = credentialsPaths(env);
  const all = readCredentialsFile(paths);
  return all[normalizeBaseUrl(baseUrl)];
}

export function setCredential(
  baseUrl: string,
  cred: StoredCredential,
  env?: Record<string, string | undefined>,
): void {
  const paths = credentialsPaths(env);
  const all = readCredentialsFile(paths);
  all[normalizeBaseUrl(baseUrl)] = cred;
  writeCredentialsFile(paths, all);
}

export function removeCredential(baseUrl: string, env?: Record<string, string | undefined>): void {
  const paths = credentialsPaths(env);
  const all = readCredentialsFile(paths);
  const key = normalizeBaseUrl(baseUrl);
  if (!(key in all)) return;
  delete all[key];
  writeCredentialsFile(paths, all);
}

export function isExpired(cred: StoredCredential, now: () => number = Date.now): boolean {
  const t = Date.parse(cred.expires_at);
  if (Number.isNaN(t)) return false; // an unparsable date is not treated as expired
  return t <= now();
}
