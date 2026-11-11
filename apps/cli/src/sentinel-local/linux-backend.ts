// Linux backend: pure /proc enumeration, no native code (design doc §8.1).
// Reads /proc/<pid>/comm for every PID under our own UID (cheap basename
// filter); only an interesting basename walks /proc/<pid>/fd/* for a live
// socket (cross-referenced against /proc/net/tcp[6]); argv is read only
// after a socket is confirmed. EACCES/ESRCH skips that PID, never the tick.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { KNOWN_INTERPRETERS } from './interpreter-tool-table.js';
import { STANDALONE_CLI_BASENAMES, BROWSER_BASENAMES } from './interpreter-tool-table.js';

export interface RawSocket {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  inode: string;
}

export interface CandidateProcess {
  pid: number;
  comm: string;
  sockets: RawSocket[];
}

function interestingBasename(comm: string): boolean {
  return KNOWN_INTERPRETERS.has(comm) || comm in STANDALONE_CLI_BASENAMES || BROWSER_BASENAMES.has(comm);
}

/** Parses /proc/net/tcp's hex address:port column. IPv4 only: the hex bytes
 * are stored in little-endian (reversed) byte order within the single
 * 32-bit word. */
export function parseTcp4Address(hex: string): string {
  if (hex.length !== 8) throw new Error(`malformed /proc/net/tcp address: ${hex}`);
  const b0 = parseInt(hex.slice(0, 2), 16);
  const b1 = parseInt(hex.slice(2, 4), 16);
  const b2 = parseInt(hex.slice(4, 6), 16);
  const b3 = parseInt(hex.slice(6, 8), 16);
  // Stored little-endian: reverse to get network-order bytes.
  return `${b3}.${b2}.${b1}.${b0}`;
}

// Parses /proc/net/tcp6's hex address column (4x 32-bit words). A common
// bug treats it as plain big-endian bytes; each word is stored little-endian
// and must be byte-reversed. Locked in against a known vector (2607:6bc0::1).
export function parseTcp6Address(hex: string): string {
  if (hex.length !== 32) throw new Error(`malformed /proc/net/tcp6 address: ${hex}`);
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    const b0 = word.slice(0, 2);
    const b1 = word.slice(2, 4);
    const b2 = word.slice(4, 6);
    const b3 = word.slice(6, 8);
    // Each word is little-endian stored; reverse its 4 bytes to get
    // network-order bytes for this word.
    bytes.push(parseInt(b3, 16), parseInt(b2, 16), parseInt(b1, 16), parseInt(b0, 16));
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    const val = ((bytes[i]! << 8) | bytes[i + 1]!) & 0xffff;
    groups.push(val.toString(16));
  }
  return groups.join(':');
}

function parsePort(hex: string): number {
  return parseInt(hex, 16);
}

/** Maps socket inode -> {remoteAddress, remotePort, localPort} from one
 * /proc/net/tcp or /proc/net/tcp6 file's contents. Local addresses stay
 * local-only (never sent on the wire; used only for observation_id). */
export function parseProcNetTcp(contents: string, family: 'v4' | 'v6'): Map<string, RawSocket> {
  const out = new Map<string, RawSocket>();
  const lines = contents.split('\n').slice(1); // header line
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const localCol = fields[1];
    const remCol = fields[2];
    const inode = fields[9];
    if (!localCol || !remCol || !inode || inode === '0') continue;
    const [localHex, localPortHex] = localCol.split(':');
    const [remHex, remPortHex] = remCol.split(':');
    if (!localHex || !localPortHex || !remHex || !remPortHex) continue;
    try {
      const localAddress = family === 'v4' ? parseTcp4Address(localHex) : parseTcp6Address(localHex);
      const remoteAddress = family === 'v4' ? parseTcp4Address(remHex) : parseTcp6Address(remHex);
      out.set(inode, {
        localAddress,
        localPort: parsePort(localPortHex),
        remoteAddress,
        remotePort: parsePort(remPortHex),
        inode,
      });
    } catch {
      continue; // malformed line: skip, never abort the whole parse
    }
  }
  return out;
}

const SOCKET_INODE_RE = /^socket:\[(\d+)\]$/;

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export interface LinuxEnumerateDeps {
  /** Overridable for tests: avoids touching the real /proc filesystem. */
  readProcNetTcp?: () => string | undefined;
  readProcNetTcp6?: () => string | undefined;
  listPids?: () => number[];
  readComm?: (pid: number) => string | undefined;
  listFds?: (pid: number) => string[];
  readFdLink?: (pid: number, fd: string) => string | undefined;
  readCmdline?: (pid: number) => string[] | undefined;
  readCwd?: (pid: number) => string | undefined;
  myUid?: () => number;
  pidUid?: (pid: number) => number | undefined;
}

function defaultDeps(): Required<LinuxEnumerateDeps> {
  return {
    readProcNetTcp: () => readFileSafe('/proc/net/tcp'),
    readProcNetTcp6: () => readFileSafe('/proc/net/tcp6'),
    listPids: () => {
      try {
        return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
      } catch {
        return [];
      }
    },
    readComm: (pid) => {
      const raw = readFileSafe(`/proc/${pid}/comm`);
      return raw?.trim();
    },
    listFds: (pid) => {
      try {
        return readdirSync(`/proc/${pid}/fd`);
      } catch {
        return [];
      }
    },
    readFdLink: (pid, fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        return undefined;
      }
    },
    readCmdline: (pid) => {
      const raw = readFileSafe(`/proc/${pid}/cmdline`);
      if (raw === undefined) return undefined;
      return raw.split('\0').filter((s) => s.length > 0);
    },
    readCwd: (pid) => {
      try {
        return readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return undefined;
      }
    },
    myUid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
    pidUid: (pid) => {
      const raw = readFileSafe(`/proc/${pid}/status`);
      if (!raw) return undefined;
      const m = raw.match(/^Uid:\s+(\d+)/m);
      return m ? Number(m[1]) : undefined;
    },
  };
}

/** Enumerates candidate processes with at least one live TCP socket, scoped
 * to the invoking user's own UID and an "interesting" comm basename. argv is
 * NOT read here - callers read it only for a process this returns (it
 * already has a confirmed live socket). */
export function enumerateLinuxCandidates(overrides: LinuxEnumerateDeps = {}): CandidateProcess[] {
  const deps = { ...defaultDeps(), ...overrides };
  const tcp4 = parseProcNetTcp(deps.readProcNetTcp() ?? '', 'v4');
  const tcp6 = parseProcNetTcp(deps.readProcNetTcp6() ?? '', 'v6');
  const myUid = deps.myUid();

  const out: CandidateProcess[] = [];
  for (const pid of deps.listPids()) {
    const uid = deps.pidUid(pid);
    if (uid !== undefined && uid !== myUid) continue; // not our own process

    const comm = deps.readComm(pid);
    if (!comm || !interestingBasename(comm)) continue;

    let fds: string[];
    try {
      fds = deps.listFds(pid);
    } catch (err) {
      if (isSkippable(err)) continue;
      throw err;
    }
    if (fds.length === 0) continue;

    const sockets: RawSocket[] = [];
    for (const fd of fds) {
      const link = deps.readFdLink(pid, fd);
      if (!link) continue;
      const m = link.match(SOCKET_INODE_RE);
      if (!m) continue;
      const inode = m[1]!;
      const sock = tcp4.get(inode) ?? tcp6.get(inode);
      if (sock) sockets.push(sock);
    }
    if (sockets.length === 0) continue; // no live socket worth classifying: never read argv

    out.push({ pid, comm, sockets });
  }
  return out;
}

function isSkippable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'ESRCH' || code === 'ENOENT';
}

export function readLinuxArgv(pid: number, overrides: LinuxEnumerateDeps = {}): string[] | undefined {
  const deps = { ...defaultDeps(), ...overrides };
  return deps.readCmdline(pid);
}

export function readLinuxCwd(pid: number, overrides: LinuxEnumerateDeps = {}): string | undefined {
  const deps = { ...defaultDeps(), ...overrides };
  return deps.readCwd(pid);
}
