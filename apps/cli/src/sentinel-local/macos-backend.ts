// macOS backend: exactly 3 subprocess calls per poll tick (design doc §8.2),
// each scoped to the smallest PID set it needs: `lsof -nP -a -i -F pcnPTt
// +c 0` (socket-holding PIDs, no path/argv), a scoped `ps -ww` for argv, then
// a scoped `lsof -d cwd` for only the PIDs classified as a known AI CLI.
// Never run lsof/ps unscoped: slow, and leaks unrelated argv for no reason.

import { classifyProcess, basenameOf } from './classify.js';
import type { Tool } from './types.js';

export interface MacSocket {
  pid: number;
  comm: string;
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
}

export interface MacCandidate {
  pid: number;
  comm: string;
  sockets: MacSocket[];
  argv?: string[];
  classification?: { processClass: 'known_ai_cli' | 'browser'; tool?: Tool };
  cwd?: string;
}

export interface ExecFn {
  (cmd: string, args: string[]): Promise<string>;
}

/** Strips lsof's `[...]` bracket wrapper around an IPv6 literal (e.g.
 * `[2607:6bc0::1]` -> `2607:6bc0::1`). A no-op for an IPv4 address or an
 * already-unbracketed one. */
function stripBrackets(addr: string): string {
  return addr.startsWith('[') && addr.endsWith(']') ? addr.slice(1, -1) : addr;
}

/**
 * Parses `lsof -nP -a -i -F pcnPTt +c 0` output: `-F` field-mode emits one
 * line per field, `p<pid>`/`c<command>`/`n<name>` among them, with a new `p`
 * line starting each process's record. The `n` field for a TCP socket looks
 * like `<local>-><remote>` (e.g. `10.0.0.5:54321->160.79.104.1:443`, or for
 * IPv6, `[2607:6bc0::1]:54321->[2607:6bc0::2]:443` - lsof brackets an IPv6
 * literal so its own embedded colons don't collide with the `:port`
 * separator).
 */
export function parseLsofSocketList(output: string): MacSocket[] {
  const out: MacSocket[] = [];
  let pid: number | undefined;
  let comm: string | undefined;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      comm = undefined;
    } else if (tag === 'c') {
      comm = value;
    } else if (tag === 'n') {
      if (pid === undefined || comm === undefined) continue;
      const m = value.match(/^(\S+):(\d+)->(\S+):(\d+)/);
      if (!m) continue;
      const [, localAddress, localPortStr, remoteAddress, remotePortStr] = m;
      out.push({
        pid,
        comm,
        localAddress: stripBrackets(localAddress!),
        localPort: Number(localPortStr),
        remoteAddress: stripBrackets(remoteAddress!),
        remotePort: Number(remotePortStr),
      });
    }
  }
  return out;
}

/** Groups parsed sockets by PID into candidates, deduplicating comm. */
export function groupByPid(sockets: MacSocket[]): Map<number, { comm: string; sockets: MacSocket[] }> {
  const out = new Map<number, { comm: string; sockets: MacSocket[] }>();
  for (const s of sockets) {
    const existing = out.get(s.pid);
    if (existing) existing.sockets.push(s);
    else out.set(s.pid, { comm: s.comm, sockets: [s] });
  }
  return out;
}

/**
 * Parses `ps -ww -o pid=,comm=,args= -p <pids>` output: one line per PID,
 * whitespace-separated pid, then comm, then the rest of the line is args
 * (which may itself contain spaces, so it is NOT re-split further; only the
 * first two whitespace-separated tokens are consumed positionally).
 */
export function parsePsArgs(output: string): Map<number, { comm: string; argv: string[] }> {
  const out = new Map<number, { comm: string; argv: string[] }>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const comm = m[2]!;
    const argsStr = m[3] ?? '';
    const argv = argsStr.length > 0 ? argsStr.split(/\s+/) : [comm];
    out.set(pid, { comm, argv });
  }
  return out;
}

/** Parses `lsof -a -p <pids> -d cwd -F pn` output into pid -> cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value);
    else if (tag === 'n' && pid !== undefined) out.set(pid, value);
  }
  return out;
}

/** Runs the exact 3 scoped subprocess calls and returns classified
 * candidates with sockets, argv, and (for known_ai_cli only) cwd. */
export async function enumerateMacCandidates(execFn: ExecFn): Promise<MacCandidate[]> {
  const lsofOut = await execFn('lsof', ['-nP', '-a', '-i', '-F', 'pcnPTt', '+c', '0']);
  const sockets = parseLsofSocketList(lsofOut);
  const byPid = groupByPid(sockets);
  if (byPid.size === 0) return [];

  const pids = [...byPid.keys()];
  const psOut = await execFn('ps', ['-ww', '-o', 'pid=,comm=,args=', '-p', pids.join(',')]);
  const psByPid = parsePsArgs(psOut);

  const candidates: MacCandidate[] = [];
  const cliPids: number[] = [];
  for (const [pid, group] of byPid) {
    const psEntry = psByPid.get(pid);
    const comm = basenameOf(psEntry?.comm ?? group.comm);
    const argv = psEntry?.argv ?? [group.comm];
    const classification = classifyProcess(comm, argv);
    const candidate: MacCandidate = { pid, comm, sockets: group.sockets, argv, ...(classification ? { classification } : {}) };
    candidates.push(candidate);
    if (classification?.processClass === 'known_ai_cli') cliPids.push(pid);
  }

  if (cliPids.length > 0) {
    const cwdOut = await execFn('lsof', ['-a', '-p', cliPids.join(','), '-d', 'cwd', '-F', 'pn']);
    const cwdByPid = parseLsofCwd(cwdOut);
    for (const c of candidates) {
      const cwd = cwdByPid.get(c.pid);
      if (cwd) c.cwd = cwd;
    }
  }

  return candidates;
}
