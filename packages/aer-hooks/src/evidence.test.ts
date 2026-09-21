// A record that lists tool calls says what happened. A record that also says
// what the collector was registered for, and how much of it arrived, lets a
// reader tell a quiet session from a broken one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readPkg } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registeredEvents, repoHead, HOOKS_VERSION } from './evidence.js';
import { install } from './install.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aer-evid-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registeredEvents', () => {
  it('reports what is actually wired, not what we meant to wire', async () => {
    await install('claude-code', { dir });
    const events = await registeredEvents('claude-code', dir);
    expect(events).toContain('SessionEnd');
    expect(events).toContain('PreToolUse');
    expect(events).toEqual([...events].sort());
  });

  it('reports nothing when the harness has no config at all', async () => {
    expect(await registeredEvents('codex', dir)).toEqual([]);
  });

  it('reports only AER entries, not somebody else hooks', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'some-other-tool' }] }] },
    }));
    expect(await registeredEvents('claude-code', dir)).toEqual([]);
  });

  it('degrades to nothing on a config it cannot read', async () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'hooks.json'), '{ not json');
    expect(await registeredEvents('codex', dir)).toEqual([]);
  });
});

describe('repoHead', () => {
  it('reads the commit a detached HEAD points at', () => {
    const sha = 'a'.repeat(40);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), `${sha}\n`);
    expect(repoHead(dir)).toBe(sha);
  });

  it('follows a symbolic HEAD to the branch tip', () => {
    const sha = 'b'.repeat(40);
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    expect(repoHead(dir)).toBe(sha);
  });

  it('finds the repository from a subdirectory', () => {
    const sha = 'c'.repeat(40);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), `${sha}\n`);
    const deep = join(dir, 'packages', 'thing', 'src');
    mkdirSync(deep, { recursive: true });
    expect(repoHead(deep)).toBe(sha);
  });

  it('returns nothing outside a repository, or for a ref it cannot resolve', () => {
    expect(repoHead(dir)).toBeUndefined();
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
    expect(repoHead(dir)).toBeUndefined();
  });

  it('refuses anything that is not a commit id', () => {
    // HEAD is a file in the working tree, so its content is attacker-shaped
    // input like any other. Only a sha is recorded.
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'cat /etc/SECRET-FILE\n');
    expect(repoHead(dir)).toBeUndefined();
  });

  it('never follows a symlinked git directory', () => {
    const other = mkdtempSync(join(tmpdir(), 'aer-evid-other-'));
    try {
      writeFileSync(join(other, 'HEAD'), 'd'.repeat(40));
      symlinkSync(other, join(dir, '.git'));
      expect(repoHead(dir)).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('gives up rather than walking to the filesystem root', () => {
    expect(repoHead('/')).toBeUndefined();
    expect(repoHead(undefined)).toBeUndefined();
  });
});

describe('HOOKS_VERSION', () => {
  it('is the version this package actually publishes', () => {
    // A record that names the wrong collector version sends a reader to the
    // wrong source when they come to check what it did.
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readPkg(pkgPath, 'utf8')) as { version: string };
    expect(HOOKS_VERSION).toBe(pkg.version);
  });
});

// Claude Code and Codex both load a project layer alongside the home one, and
// all matching layers load rather than the nearest replacing the rest. A real
// run reported the home layer's events while the project layer was the one
// actually firing, so the record described a registration that was not in use.
describe('registeredEvents across config layers', () => {
  it('unions the project layer with the home one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aer-home-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code' }] }] },
      }));
      await install('claude-code', { dir });
      const events = await registeredEvents('claude-code', home, dir);
      expect(events).toContain('Stop');
      expect(events).toContain('SessionEnd');
      expect(events).toEqual([...new Set(events)].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports the project layer even when the home one has nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aer-home-'));
    try {
      await install('claude-code', { dir });
      expect(await registeredEvents('claude-code', home, dir)).toContain('SessionEnd');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores a project directory that is not one', async () => {
    await install('claude-code', { dir });
    expect(await registeredEvents('claude-code', dir, '/nonexistent-xyz')).toContain('SessionEnd');
  });
});
