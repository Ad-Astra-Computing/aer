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
  statSync,
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

// Thrown instead of silently treating unreadable content as "no credentials",
// which would otherwise get overwritten (clobbered) by the next write.
export class CredentialsCorruptError extends Error {
  constructor(public readonly originalPath: string, public readonly movedTo: string) {
    super(`${originalPath} was not a valid credentials file; moved it to ${movedTo}. Run \`aer login\` again.`);
    this.name = 'CredentialsCorruptError';
  }
}

/** Resolves the credentials directory + file path, honoring XDG_CONFIG_HOME. */
export function credentialsPaths(env: Record<string, string | undefined> = process.env): CredentialsPaths {
  const xdg = env['XDG_CONFIG_HOME'];
  const configHome = xdg && xdg.trim() !== '' ? xdg : join(env['HOME'] ?? homedir(), '.config');
  const dir = join(configHome, 'aer');
  return { dir, file: join(dir, 'credentials.json') };
}

/**
 * Strips a trailing slash and lowercases the host, so the same origin always
 * maps to the same credentials-file key. Refuses a URL with embedded
 * credentials (user:pass@host) rather than silently dropping them. Falls
 * back to a plain trailing-slash strip for a value `new URL()` cannot parse,
 * so a malformed AER_BASE_URL still degrades to the old, predictable key.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
  if (url.username || url.password) {
    throw new Error('refusing a base URL with embedded credentials');
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
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

// File permission bits are not a meaningful signal on Windows (no POSIX
// mode bits; access is governed by NTFS ACLs instead), so this warns only
// on POSIX platforms. Windows users rely on the per-user profile directory
// ACL instead; see the CLI README for the documented caveat.
function warnIfLoosePermissions(path: string, warn: (msg: string) => void): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode > 0o600) {
      warn(`warning: ${path} is readable by more than its owner (mode ${mode.toString(8)}); run \`chmod 600 ${path}\``);
    }
  } catch {
    /* best effort */
  }
}

function quarantineCorruptFile(paths: CredentialsPaths): CredentialsCorruptError {
  const movedTo = `${paths.file}.corrupt`;
  try {
    renameSync(paths.file, movedTo);
  } catch {
    /* best effort: still refuse below even if the move itself failed */
  }
  return new CredentialsCorruptError(paths.file, movedTo);
}

export interface ReadOptions {
  warn?: (msg: string) => void;
}

/**
 * Reads the whole credentials file. A missing file reads as empty. Content
 * that is not valid JSON, or not a plain object, is never silently treated
 * as empty (that would clobber it on the next write): it is moved aside to
 * `credentials.json.corrupt` and CredentialsCorruptError is thrown.
 */
export function readCredentialsFile(paths: CredentialsPaths, opts: ReadOptions = {}): CredentialsFile {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  assertNotSymlink(paths.dir);
  if (!existsSync(paths.file)) return {};
  assertNotSymlink(paths.file);
  warnIfLoosePermissions(paths.file, warn);

  let raw: string;
  try {
    raw = readFileSync(paths.file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw quarantineCorruptFile(paths);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw quarantineCorruptFile(paths);
  }
  return parsed as CredentialsFile;
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

/** A defensive shape check: a malformed entry (e.g. hand-edited or from a
 * future/older CLI version) is treated as absent rather than crashing a
 * caller that assumes `api_key` etc. are present strings. Format rules
 * (UUID tenant_id, role domain) are enforced once, at the point the server's
 * grant is first accepted, in device-login.ts; this only guards shape. */
export function isValidStoredCredential(cred: unknown): cred is StoredCredential {
  if (!cred || typeof cred !== 'object') return false;
  const c = cred as Record<string, unknown>;
  return (
    typeof c['api_key'] === 'string' && c['api_key'].length > 0 &&
    typeof c['key_id'] === 'string' && c['key_id'].length > 0 &&
    typeof c['tenant_id'] === 'string' && c['tenant_id'].length > 0 &&
    typeof c['role'] === 'string' && c['role'].length > 0 &&
    typeof c['expires_at'] === 'string' && !Number.isNaN(Date.parse(c['expires_at']))
  );
}

export function getCredential(baseUrl: string, env?: Record<string, string | undefined>): StoredCredential | undefined {
  const paths = credentialsPaths(env);
  const all = readCredentialsFile(paths);
  const cred = all[normalizeBaseUrl(baseUrl)];
  return isValidStoredCredential(cred) ? cred : undefined;
}

/** All base URLs with a (structurally valid) stored entry. Used by `aer
 * logout --all` and by the "you're logged in elsewhere" hint. */
export function listCredentialBaseUrls(env?: Record<string, string | undefined>): string[] {
  const paths = credentialsPaths(env);
  const all = readCredentialsFile(paths);
  return Object.keys(all).filter((k) => isValidStoredCredential(all[k]));
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
