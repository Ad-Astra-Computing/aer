import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findWorkspaceRoot, gateDecision, hashFileForEffectDigest, hashBeforeDigest,
  MAX_FILE_DIGEST_BYTES, MAX_AGGREGATE_DIGEST_BYTES,
} from './effect-digest.js';

let dir: string;

// A real-OS tmpdir sandbox (segments[0] === 'tmp') would itself classify as
// PathClass 'tmp' and fail the hashable-class gate, and the package
// directory sits inside the real git worktree (a findWorkspaceRoot walk-up
// would hit its real .git), so the sandbox lives under the home directory
// instead, outside both.
const SCRATCH_ROOT = path.join(os.homedir(), '.aer-effect-digest-test-scratch');

beforeEach(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
});

afterEach(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const KEY = Buffer.alloc(32, 0x01);

describe('findWorkspaceRoot', () => {
  it('walks up to find a .git directory', () => {
    const repo = path.join(dir, 'repo');
    const nested = path.join(repo, 'src', 'lib');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(repo);
  });

  it('falls back to cwd when no .git is found', () => {
    const lonely = path.join(dir, 'lonely');
    fs.mkdirSync(lonely, { recursive: true });
    expect(findWorkspaceRoot(lonely)).toBe(lonely);
  });

  it('passes through a relative or undefined cwd unchanged', () => {
    expect(findWorkspaceRoot(undefined)).toBeUndefined();
    expect(findWorkspaceRoot('relative/path')).toBe('relative/path');
  });
});

describe('gateDecision', () => {
  const root = '/repo';

  it('refuses a path outside the workspace root', () => {
    expect(gateDecision('/home/user/.ssh/id_rsa', root)).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
    expect(gateDecision('/repo/../outside.txt', root)).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
  });

  it('refuses a .git path even though classifyPath returns null for it', () => {
    expect(gateDecision('/repo/.git/config', root)).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
  });

  it('refuses a credential-class path inside the workspace', () => {
    expect(gateDecision('/repo/.env.local', root)).toEqual({ hashable: false, pathClass: 'env_file', status: 'credential_class' });
  });

  it('refuses an unclassified secret shape inside the workspace', () => {
    expect(gateDecision('/repo/server.pem', root)).toEqual({ hashable: false, pathClass: 'secret_material', status: 'credential_class' });
  });

  it('allows an ordinary unclassified workspace path', () => {
    expect(gateDecision('/repo/src/index.ts', root)).toEqual({ hashable: true, pathClass: null });
  });

  it('allows an allowlisted class inside the workspace', () => {
    expect(gateDecision('/repo/package.json', root)).toEqual({ hashable: true, pathClass: 'package_manifest' });
  });

  it('refuses with no workspace root at all', () => {
    expect(gateDecision('/repo/src/index.ts', undefined)).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
  });

  // Security review F9: findWorkspaceRoot falls back to cwd with no .git
  // found above it, so a harness started in $HOME (or a dotfiles repo) would
  // otherwise make everything under the home directory hashable.
  it('refuses a workspace root equal to the home directory', () => {
    const home = os.homedir();
    expect(gateDecision(path.join(home, 'notes.txt'), home)).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
  });

  it('refuses a workspace root equal to the filesystem root', () => {
    expect(gateDecision('/notes.txt', '/')).toEqual({ hashable: false, pathClass: null, status: 'outside_workspace' });
  });
});

describe('hashFileForEffectDigest', () => {
  it('reports no_key when no commitment key is configured', async () => {
    const r = await hashFileForEffectDigest(path.join(dir, 'x.ts'), dir, null, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'no_key' });
  });

  it('refuses a path outside the workspace before touching the filesystem', async () => {
    const r = await hashFileForEffectDigest('/etc/passwd', dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'outside_workspace' });
  });

  it('hashes an ordinary workspace file and matches the fixed vector', async () => {
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello world');
    const budget = { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES };
    const r = await hashFileForEffectDigest(file, dir, KEY, budget);
    // Same vector as commitment-key.test.ts: key = 32 bytes of 0x01, "hello world".
    expect(r).toEqual({ status: 'ok', sha256: '46b5cdf815859bf739f6d07509de297df65d5444ea08193bb933e2c22492e7ed', bytes: 11 });
    expect(budget.remainingBytes).toBe(MAX_AGGREGATE_DIGEST_BYTES - 11);
  });

  it('hashes a zero-byte file without ever opening a read stream on it', async () => {
    const file = path.join(dir, 'empty.txt');
    fs.writeFileSync(file, '');
    const r = await hashFileForEffectDigest(file, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r.status).toBe('ok');
    expect(r.bytes).toBe(0);
  });

  // Security review F5: the read is bounded to [0, fstat'd size), not "until
  // EOF", so bytes appended mid-read can't inflate `bytes` past that value.
  // Every passing 'ok' case above already proves this (bytes == size).

  it('refuses a symlink via lstat, never following it', async () => {
    const target = path.join(dir, 'real.txt');
    fs.writeFileSync(target, 'secret-ish');
    const link = path.join(dir, 'link.txt');
    fs.symlinkSync(target, link);
    const r = await hashFileForEffectDigest(link, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'symlink' });
  });

  it('refuses a non-regular file (a directory passed as a path)', async () => {
    const sub = path.join(dir, 'adir');
    fs.mkdirSync(sub);
    const r = await hashFileForEffectDigest(sub, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'not_regular_file' });
  });

  it('reports unreadable for a path that does not exist', async () => {
    const r = await hashFileForEffectDigest(path.join(dir, 'missing.txt'), dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'unreadable' });
  });

  it('refuses a file over the per-file cap', async () => {
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(MAX_FILE_DIGEST_BYTES + 1));
    const r = await hashFileForEffectDigest(file, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'size' });
  });

  it('refuses a file that would push the shared aggregate budget over, even under the per-file cap', async () => {
    const file = path.join(dir, 'small.bin');
    fs.writeFileSync(file, Buffer.alloc(100));
    const r = await hashFileForEffectDigest(file, dir, KEY, { remainingBytes: 50 });
    expect(r).toEqual({ status: 'size' });
  });

  // Security review F1, reproduced then fixed: a symlinked ANCESTOR
  // directory is invisible to lstat on the final component and to
  // gateDecision's lexical path check, since the literal path string still
  // reads as inside the workspace. Before the fix this returned 'ok' with a
  // real digest of the file outside the workspace.
  it('refuses a file reached through a symlinked ancestor directory, even though the literal path is inside the workspace', async () => {
    const secretDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'outside-'));
    const secret = path.join(secretDir, 'id_rsa');
    fs.writeFileSync(secret, 'not-really-a-private-key-just-test-content');
    const link = path.join(dir, 'link');
    fs.symlinkSync(secretDir, link);
    const viaLink = path.join(link, 'id_rsa');
    const r = await hashFileForEffectDigest(viaLink, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r.status).not.toBe('ok');
  });

  // Security review F1, reproduced then fixed: a hard link gives the same
  // inode a second, workspace-local name that lstat and classifyPath see as
  // an ordinary file with no reason to think it is also ~/.ssh/id_rsa.
  it('refuses a hard link to a file outside the workspace', async () => {
    const secretDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'outside-'));
    const secret = path.join(secretDir, 'id_rsa');
    fs.writeFileSync(secret, 'not-really-a-private-key-just-test-content');
    const insideLink = path.join(dir, 'notes.txt');
    fs.linkSync(secret, insideLink);
    const r = await hashFileForEffectDigest(insideLink, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toEqual({ status: 'not_regular_file' });
  });

  // Security review F1-R1, reproduced then fixed: a symlinked directory
  // alias stays INSIDE the workspace (so the escape check alone passes it)
  // while resolving to .git, the exact directory the git exclusion exists
  // to protect. Before this fix the literal path "g/config" carried no .git
  // segment and classified as null (hashable).
  it('refuses a .git path reached through a workspace-internal symlinked alias', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
    const alias = path.join(dir, 'g');
    fs.symlinkSync(path.join(dir, '.git'), alias);
    const r = await hashFileForEffectDigest(path.join(alias, 'config'), dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r.status).not.toBe('ok');
  });
});

describe('hashBeforeDigest', () => {
  it('is undefined (not an error) for a brand-new file', async () => {
    const r = await hashBeforeDigest(path.join(dir, 'new.ts'), dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toBeUndefined();
  });

  it('is the digest for an existing file', async () => {
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello world');
    const r = await hashBeforeDigest(file, dir, KEY, { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES });
    expect(r).toBe('46b5cdf815859bf739f6d07509de297df65d5444ea08193bb933e2c22492e7ed');
  });
});
