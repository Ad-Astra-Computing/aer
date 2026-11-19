import { describe, it, expect, vi } from 'vitest';
import {
  parseLsofSocketList,
  parsePsArgs,
  parseLsofCwd,
  enumerateMacCandidates,
} from './macos-backend.js';

describe('parseLsofSocketList', () => {
  it('parses a field-mode lsof -F pcnPTt record', () => {
    const output = [
      'p123',
      'cclaude',
      'PTCP',
      'n10.0.0.5:54321->160.79.104.1:443',
      'p456',
      'cchrome',
      'PTCP',
      'n10.0.0.5:54322->1.1.1.1:443',
    ].join('\n');
    const sockets = parseLsofSocketList(output);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]).toMatchObject({ pid: 123, comm: 'claude', remoteAddress: '160.79.104.1', remotePort: 443 });
    expect(sockets[1]).toMatchObject({ pid: 456, comm: 'chrome', remoteAddress: '1.1.1.1', remotePort: 443 });
  });

  it('ignores a non-connection name line', () => {
    const output = ['p1', 'cfoo', 'n/var/log/foo.log'].join('\n');
    expect(parseLsofSocketList(output)).toHaveLength(0);
  });

  it('skips a UDP/QUIC record, keeping only TCP (B4)', () => {
    const output = [
      'p123',
      'cclaude',
      'PTCP',
      'n10.0.0.5:54321->160.79.104.1:443',
      'p456',
      'cquic-thing',
      'PUDP',
      'n10.0.0.5:54322->1.1.1.1:443',
    ].join('\n');
    const sockets = parseLsofSocketList(output);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toMatchObject({ pid: 123, comm: 'claude' });
  });

  it('strips brackets from a bracketed IPv6 connection (B7)', () => {
    const output = [
      'p123',
      'cclaude',
      'n[2607:6bc0::1]:54321->[2607:6bc0::2]:443',
    ].join('\n');
    const sockets = parseLsofSocketList(output);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toMatchObject({
      localAddress: '2607:6bc0::1',
      remoteAddress: '2607:6bc0::2',
      remotePort: 443,
    });
  });
});

describe('parsePsArgs', () => {
  it('parses pid/comm/args, where args is the real full command line (argv[0] included, same as comm)', () => {
    const output = [
      '123 node node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --flag value',
      '456 chrome chrome --type=gpu-process',
    ].join('\n');
    const map = parsePsArgs(output);
    expect(map.get(123)).toEqual({
      comm: 'node',
      argv: ['node', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--flag', 'value'],
    });
    expect(map.get(456)?.comm).toBe('chrome');
  });
});

describe('parseLsofCwd', () => {
  it('maps pid to its cwd path', () => {
    const output = ['p123', 'n/Users/dev/project'].join('\n');
    expect(parseLsofCwd(output).get(123)).toBe('/Users/dev/project');
  });
});

describe('enumerateMacCandidates: exactly 3 scoped subprocess calls', () => {
  it('runs lsof, scoped ps, then scoped lsof -d cwd (only for known_ai_cli pids)', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'lsof' && args.includes('-iTCP')) {
        return [
          'p123', 'cclaude', 'n10.0.0.5:1->160.79.104.1:443',
          'p456', 'cchrome', 'n10.0.0.5:2->1.1.1.1:443',
        ].join('\n');
      }
      if (cmd === 'ps') {
        return [
          '123 node node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          '456 chrome chrome --type=renderer',
        ].join('\n');
      }
      if (cmd === 'lsof' && args.includes('-d')) {
        return ['p123', 'n/Users/dev/project'].join('\n');
      }
      throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
    });

    const candidates = await enumerateMacCandidates(execFn);
    expect(calls).toHaveLength(3);
    // call 1: unscoped socket enumeration (the one call allowed to be
    // broad), scoped to TCP only (B4) - never UDP/QUIC.
    expect(calls[0]!.args).toContain('-iTCP');
    // call 2: scoped ps, only the PIDs from call 1
    expect(calls[1]!.cmd).toBe('ps');
    expect(calls[1]!.args.join(' ')).toContain('123,456');
    // call 3: scoped lsof -d cwd, ONLY the known_ai_cli pid (123, not chrome's 456)
    expect(calls[2]!.args).toContain('-d');
    expect(calls[2]!.args.join(' ')).not.toContain('456');

    const claude = candidates.find((c) => c.pid === 123);
    expect(claude?.classification).toEqual({ processClass: 'known_ai_cli', tool: 'claude_code' });
    expect(claude?.cwd).toBe('/Users/dev/project');

    const chrome = candidates.find((c) => c.pid === 456);
    expect(chrome?.classification).toEqual({ processClass: 'browser' });
    expect(chrome?.cwd).toBeUndefined();
  });

  it('skips the cwd call entirely when no PID classifies as a known AI CLI', async () => {
    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'lsof' && args.includes('-iTCP')) return ['p1', 'cchrome', 'n1:1->1.1.1.1:443'].join('\n');
      if (cmd === 'ps') return ['1 chrome chrome --type=renderer'].join('\n');
      throw new Error('cwd call should not run');
    });
    const candidates = await enumerateMacCandidates(execFn);
    expect(execFn).toHaveBeenCalledTimes(2);
    expect(candidates[0]?.cwd).toBeUndefined();
  });

  it('returns no candidates and makes no further calls when nothing holds a socket', async () => {
    const execFn = vi.fn(async () => '');
    const candidates = await enumerateMacCandidates(execFn);
    expect(candidates).toHaveLength(0);
    expect(execFn).toHaveBeenCalledTimes(1);
  });
});
