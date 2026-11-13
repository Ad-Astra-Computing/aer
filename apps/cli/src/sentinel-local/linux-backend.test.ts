import { describe, it, expect } from 'vitest';
import {
  parseTcp4Address,
  parseTcp6Address,
  parseProcNetTcp,
  enumerateLinuxCandidates,
} from './linux-backend.js';

describe('parseTcp4Address', () => {
  it('decodes the canonical /proc/net/tcp loopback vector', () => {
    expect(parseTcp4Address('0100007F')).toBe('127.0.0.1');
  });
  it('decodes an owned-range address', () => {
    // 160.79.104.1 = A0.4F.68.01 -> little-endian stored = "01684FA0"
    expect(parseTcp4Address('01684FA0')).toBe('160.79.104.1');
  });
});

describe('parseTcp6Address - known vector, byte order locked in', () => {
  it('decodes 2607:6bc0::1 from its little-endian-per-word /proc/net/tcp6 encoding', () => {
    // Derived byte-for-byte from the real kernel encoding (4 32-bit words,
    // each word byte-reversed) - this is the vector that catches the common
    // "forgot the per-word byte swap" bug.
    const hex = 'C06B0726000000000000000001000000'.slice(0, 32);
    expect(parseTcp6Address(hex)).toBe('2607:6bc0:0:0:0:0:0:1');
  });

  it('decodes ::1 (loopback)', () => {
    const hex = '00000000000000000000000001000000';
    expect(parseTcp6Address(hex)).toBe('0:0:0:0:0:0:0:1');
  });

  it('decodes a real /proc/net/tcp6 IPv4-mapped peer (160.79.104.1) to its mapped literal', () => {
    // groups 0,0,0,0,0,ffff,a04f,6801 -> ::ffff:160.79.104.1, encoded the
    // same per-word-little-endian way as every other /proc/net/tcp6 field.
    const hex = '0000000000000000ffff000001684fa0';
    expect(parseTcp6Address(hex)).toBe('0:0:0:0:0:ffff:a04f:6801');
  });

  it('round-trips through ipInCidr for the owned IPv6 range', async () => {
    const { ipInCidr } = await import('./provider-ranges.js');
    const addr = parseTcp6Address('C06B0726000000000000000001000000');
    expect(ipInCidr(addr, '2607:6bc0::/32')).toBe(true);
  });

  it('a Linux v4-mapped tcp6 remote address matches the owned IPv4 CIDR range (B7)', async () => {
    const { classifyAgainstOwnedRanges } = await import('./provider-ranges.js');
    // The literal form Linux's /proc/net/tcp6 produces for an IPv4-mapped
    // peer (160.79.104.1), per parseTcp6Address's own documented output
    // shape (8 colon-separated hex groups, uncompressed).
    const v4Mapped = '0:0:0:0:0:ffff:a04f:6801';
    expect(classifyAgainstOwnedRanges(v4Mapped)).toEqual({ evidence: 'provider_owned_range', family: 'anthropic' });
  });
});

describe('parseProcNetTcp', () => {
  it('parses a realistic /proc/net/tcp body, keyed by inode', () => {
    const body = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 01684FA0:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0',
    ].join('\n');
    const map = parseProcNetTcp(body, 'v4');
    const sock = map.get('123456');
    expect(sock?.remoteAddress).toBe('160.79.104.1');
    expect(sock?.remotePort).toBe(443);
    expect(sock?.localPort).toBe(8080);
  });

  it('skips a malformed line without throwing', () => {
    const body = ['header', '   0: garbage'].join('\n');
    expect(() => parseProcNetTcp(body, 'v4')).not.toThrow();
  });

  it('skips inode 0 (unassociated socket)', () => {
    const body = [
      'header',
      '   0: 0100007F:1F90 01684FA0:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0',
    ].join('\n');
    expect(parseProcNetTcp(body, 'v4').size).toBe(0);
  });
});

describe('enumerateLinuxCandidates', () => {
  const tcpBody = [
    'header',
    '   0: 0100007F:1F90 01684FA0:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 999 1 0000000000000000 100 0 0 10 0',
  ].join('\n');

  it('only walks fds for an interesting basename, and only reads argv for a confirmed socket holder', () => {
    const fdReads: number[] = [];
    const cmdlineReads: number[] = [];
    const candidates = enumerateLinuxCandidates({
      readProcNetTcp: () => tcpBody,
      readProcNetTcp6: () => 'header',
      listPids: () => [1, 2, 3],
      myUid: () => 1000,
      pidUid: () => 1000,
      readComm: (pid) => (pid === 1 ? 'claude' : pid === 2 ? 'sshd' : 'node'),
      listFds: (pid) => {
        fdReads.push(pid);
        if (pid === 1) return ['3', '4'];
        if (pid === 3) return ['5'];
        return [];
      },
      readFdLink: (pid, fd) => {
        if (pid === 1 && fd === '4') return 'socket:[999]';
        return '/dev/null';
      },
      readCmdline: (pid) => {
        cmdlineReads.push(pid);
        return ['claude'];
      },
    });

    // sshd is not interesting: never even listed for fd walking.
    expect(fdReads).toContain(1);
    expect(fdReads).not.toContain(2);
    // pid 3 (node) has fds but none resolve to a live socket: no candidate, no argv read.
    expect(candidates.map((c) => c.pid)).toEqual([1]);
    expect(candidates[0]!.sockets[0]!.remoteAddress).toBe('160.79.104.1');
  });

  it('skips a PID that throws EACCES without aborting the whole scan', () => {
    const candidates = enumerateLinuxCandidates({
      readProcNetTcp: () => tcpBody,
      readProcNetTcp6: () => 'header',
      listPids: () => [1, 2],
      myUid: () => 1000,
      pidUid: () => 1000,
      readComm: (pid) => (pid === 1 ? 'claude' : 'codex'),
      listFds: (pid) => {
        if (pid === 1) {
          const err = new Error('eacces') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return ['6'];
      },
      readFdLink: () => 'socket:[999]',
    });
    expect(candidates.map((c) => c.pid)).toEqual([2]);
  });

  it('filters out processes not owned by the invoking user', () => {
    const candidates = enumerateLinuxCandidates({
      readProcNetTcp: () => tcpBody,
      readProcNetTcp6: () => 'header',
      listPids: () => [1],
      myUid: () => 1000,
      pidUid: () => 0, // root-owned, not ours
      readComm: () => 'claude',
      listFds: () => ['4'],
      readFdLink: () => 'socket:[999]',
    });
    expect(candidates).toHaveLength(0);
  });

  // S4: an unreadable/malformed /proc/<pid>/status must fail closed (skip
  // the PID), never fall through as if it were the invoking user's own.
  it('skips a PID whose UID cannot be determined (fail closed)', () => {
    const candidates = enumerateLinuxCandidates({
      readProcNetTcp: () => tcpBody,
      readProcNetTcp6: () => 'header',
      listPids: () => [1],
      myUid: () => 1000,
      pidUid: () => undefined, // /proc/<pid>/status unreadable or malformed
      readComm: () => 'claude',
      listFds: () => ['4'],
      readFdLink: () => 'socket:[999]',
    });
    expect(candidates).toHaveLength(0);
  });
});
